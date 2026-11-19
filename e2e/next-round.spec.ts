import { test, expect } from '@playwright/test';
import { OTHER_PAGE_MS, playOneLegalCard, seatAndDeal } from './helpers';

test('the guest deals the next round after a full first round', async ({ browser }) => {
  test.setTimeout(240_000); // 48 moves take 1.3-2 min
  const hostCtx = await browser.newContext({ viewport: { width: 390, height: 664 } });
  const guestCtx = await browser.newContext({ viewport: { width: 390, height: 664 } });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();
  await seatAndDeal(host, guest);

  const next = (p: typeof host) => p.getByRole('button', { name: 'Deal next round' });
  const pages = [host, guest];
  const whoseTurn = async () =>
    (await host.getByText('Your turn', { exact: true }).isVisible())
      ? 'host'
      : (await guest.getByText('Your turn', { exact: true }).isVisible())
        ? 'guest'
        : '';
  // Play all 48 cards: each turn, whichever page shows "Your turn" plays one legal card.
  for (let move = 0; move < 48; move++) {
    await expect.poll(whoseTurn).not.toBe('');
    const hostTurn = (await whoseTurn()) === 'host';
    const actor = hostTurn ? host : guest;
    const other = hostTurn ? guest : host;
    await playOneLegalCard(actor);
    // Wait until the move landed on both screens before the next one.
    if (move < 47) await expect(other.getByText('Your turn', { exact: true })).toBeVisible();
  }

  // Round is over for both; the guest (not the host) deals.
  await expect(next(host)).toBeVisible();
  await expect(next(guest)).toBeEnabled({ timeout: OTHER_PAGE_MS });
  await expect(host.getByText('Waiting for the host')).toHaveCount(0);
  await next(guest).click();
  for (const p of pages) {
    await expect(p.getByText(/round 2 · deal 1/i).first()).toBeVisible({ timeout: OTHER_PAGE_MS });
    await expect(p.locator('.hand-cards button.playing-card')).toHaveCount(4, {
      timeout: OTHER_PAGE_MS,
    });
    await expect(next(p)).toHaveCount(0, { timeout: OTHER_PAGE_MS });
  }
  await expect(host.getByText(/Guesty dealt round 2/)).toBeVisible({ timeout: OTHER_PAGE_MS });
});

test('a deal that lost the race shows the new round, not an error', async ({ browser }) => {
  const hostCtx = await browser.newContext({ viewport: { width: 390, height: 664 } });
  const guestCtx = await browser.newContext({ viewport: { width: 390, height: 664 } });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();
  const code = await seatAndDeal(host, guest);

  // Play the rest of round 1 through the API, using each page's own cookie.
  const api = (page: typeof host, body: Record<string, unknown>) =>
    page.evaluate(async (b) => {
      const r = await fetch('/api/game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(b),
      });
      return r.json();
    }, body);
  const read = (page: typeof host) =>
    page.evaluate(async (c) => (await fetch('/api/game?code=' + c)).json(), code);
  let state = await read(host);
  while (state.phase === 'playing') {
    const page = state.turn === 0 ? host : guest;
    state = await read(page);
    const card = state.players[state.turn].hand[0] as string;
    // First card that is legal with an empty capture, else try single-card captures.
    const tries: string[][] = [[], ...(state.pool as string[]).map((c) => [c])];
    let next = null;
    for (const take of tries) {
      const r = await api(page, { action: 'play', code, card, take, revision: state.revision });
      if (!r.error) {
        next = r;
        break;
      }
    }
    if (!next) {
      // Fall back to the card/take combinations the UI would offer: any subset of the pool.
      const pool = state.pool as string[];
      for (let mask = 1; mask < 1 << pool.length && !next; mask++) {
        const take = pool.filter((_, k) => mask & (1 << k));
        const r = await api(page, { action: 'play', code, card, take, revision: state.revision });
        if (!r.error) next = r;
      }
    }
    if (!next) throw new Error('No legal play found');
    state = next;
  }
  expect(state.phase).toBe('round');

  // Hold the host page's polls so it keeps showing the old table.
  const held: (() => void)[] = [];
  let hold = false;
  await host.route('**/api/game?code=*', async (route) => {
    if (!hold) return route.continue();
    await new Promise<void>((release) => held.push(release));
    await route.continue().catch(() => {});
  });
  // Make sure the host page is on the round-end screen before holding.
  await expect(host.getByRole('button', { name: 'Deal next round' })).toBeVisible({
    timeout: OTHER_PAGE_MS,
  });
  await expect(guest.getByRole('button', { name: 'Deal next round' })).toBeVisible({
    timeout: OTHER_PAGE_MS,
  });
  hold = true;

  // The guest deals round 2 through the UI.
  await guest.getByRole('button', { name: 'Deal next round' }).click();
  await expect(guest.getByText(/round 2 · deal 1/i)).toBeVisible({ timeout: OTHER_PAGE_MS });
  await expect(host.getByRole('button', { name: 'Deal next round' })).toBeVisible({
    timeout: OTHER_PAGE_MS,
  });

  // The host, still on round 1, presses the button: its POST gets 409.
  const conflict = host.waitForResponse(
    (r) => r.url().endsWith('/api/game') && r.request().method() === 'POST',
  );
  await host.getByRole('button', { name: 'Deal next round' }).click();
  expect((await conflict).status()).toBe(409);

  // Let the page's recovery fetch (and the held polls) through.
  hold = false;
  held.splice(0).forEach((release) => release());
  await expect(host.getByText(/round 2 · deal 1/i)).toBeVisible({ timeout: OTHER_PAGE_MS });
  await expect(host.locator('[role="alert"]')).toHaveCount(0);
  await expect(host.getByText(/Guesty dealt round 2/)).toBeVisible({ timeout: OTHER_PAGE_MS });
});

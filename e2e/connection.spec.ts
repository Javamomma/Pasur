import { test, expect, type Page } from '@playwright/test';
import { playOneLegalCard, seatAndDeal } from './helpers';

const post = (page: Page, route: string, data: unknown) =>
  page.request.post(`/__table/${route}`, { data });
const rooms = async (page: Page, code: string) =>
  ((await (await page.request.get('/__table/rooms')).json()) as { code: string; revision: number }[]).find(
    (r) => r.code === code,
  )!;

async function twoPlayers(browser: import('@playwright/test').Browser) {
  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  const code = await seatAndDeal(host, guest);
  return { host, guest, code };
}

test('a hung move is sent once, the button comes back, no duplicate move', async ({ browser }) => {
  const { host, guest, code } = await twoPlayers(browser);
  const hostTurn = await host.getByText('Your turn', { exact: true }).isVisible();
  const mover = hostTurn ? host : guest;
  const before = (await rooms(host, code)).revision;
  await post(host, 'hold', { ms: 20000, count: 1, action: 'play' });
  const hand = mover.locator('.hand-cards button.playing-card');
  expect(await hand.count()).toBe(4);
  await playOneLegalCard(mover);
  const notice = mover.getByText('Not sure that went through');
  await expect(notice).toBeVisible({ timeout: 12_000 });
  // The check shows the move was stored: three cards left, notice gone, exactly one revision more.
  await expect(hand).toHaveCount(3, { timeout: 5_000 });
  await expect(notice).toBeHidden();
  expect((await rooms(host, code)).revision).toBe(before + 1);
  await expect(mover.getByRole('alert')).toHaveCount(0);
});

test('a seat lost on the server says so, with a way home, and never Reconnecting', async ({ browser }) => {
  const { host, guest, code } = await twoPlayers(browser);
  await post(host, 'unseat', { code, seat: 1 });
  await expect(guest.getByText('This browser is no longer seated at this table.')).toBeVisible({
    timeout: 8_000,
  });
  await expect(guest.getByText('Reconnecting')).toHaveCount(0);
  await guest.getByRole('button', { name: 'Back to the home screen' }).click();
  await expect(guest.getByRole('button', { name: 'Back to your table' })).toHaveCount(0);
  await expect(guest.getByRole('button', { name: /Create private table/ })).toBeVisible();
  expect(await guest.evaluate(() => localStorage.getItem('pasur-last-table'))).toBeNull();
});

test('a deleted table says so and stops polling', async ({ browser }) => {
  const { host, guest, code } = await twoPlayers(browser);
  await post(host, 'delete', { code });
  await expect(guest.getByText('This table no longer exists.')).toBeVisible({ timeout: 8_000 });
  await expect(guest.getByText('Reconnecting')).toHaveCount(0);
  const polls = () => guest.evaluate(() => performance.getEntriesByType('resource').length);
  const n = await polls();
  await guest.waitForTimeout(3500);
  expect(await polls()).toBe(n);
  await guest.getByRole('button', { name: 'Back to the home screen' }).click();
  await expect(guest.getByRole('button', { name: 'Back to your table' })).toHaveCount(0);
});

test('polling pauses after 10 quiet minutes and a tap resumes it', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const host = await (await browser.newContext()).newPage();
  const guest = page;
  await page.clock.install();
  const code = await seatAndDeal(host, guest);
  let gets = 0;
  page.on('request', (r) => {
    if (r.method() === 'GET' && r.url().includes('/api/game')) gets++;
  });
  await page.clock.runFor(10_000);
  expect(gets).toBeGreaterThan(0);
  await page.clock.fastForward(11 * 60_000);
  const paused = page.getByRole('button', { name: /Paused while nobody is playing/ });
  await expect(paused).toBeVisible();
  await page.clock.runFor(30_000);
  const atPause = gets;
  await page.clock.runFor(60_000);
  expect(gets).toBe(atPause);
  await paused.click();
  await expect.poll(() => gets).toBeGreaterThan(atPause);
  await expect(paused).toBeHidden();
  const resumed = gets;
  // Replies take real time, so keep advancing the fake clock until the schedule has run again.
  await expect
    .poll(async () => {
      await page.clock.runFor(2_000);
      return gets;
    })
    .toBeGreaterThan(resumed);
  expect(code).toMatch(/^[A-Z2-9]{10}$/);
});

test('an old timed-out submission cannot free the button of a newer pending Create', async ({
  browser,
}) => {
  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  await host.goto('/');
  await host.getByPlaceholder('Name at the table').fill('Hosty');
  await host.getByRole('button', { name: /Create private table/ }).click();
  const code = (await host.getByRole('button', { name: 'Copy table code' }).innerText()).trim();
  await guest.goto(`/?table=${code}`);
  await guest.getByPlaceholder('Name at the table').fill('Guesty');
  await guest.getByRole('button', { name: 'Join table' }).click();
  await expect(guest.getByText('Waiting for the host to deal')).toBeVisible();

  let releaseCreate!: () => void;
  const createHeld = new Promise<void>((r) => (releaseCreate = r));
  await host.route('**/api/game', async (route) => {
    const req = route.request();
    const action = req.method() === 'POST' ? req.postDataJSON()?.action : '';
    if (action === 'start') return new Promise(() => {}); // the deal never answers
    if (action === 'create') await createHeld;
    return route.continue();
  });

  await host.getByRole('button', { name: 'Deal the cards' }).click();
  await host.waitForTimeout(6_000); // the deal would time out at 10 s
  await host.getByRole('button', { name: 'Pasur home' }).click();
  await host.getByRole('button', { name: /Create private table/ }).click();
  const pending = host.getByRole('button', { name: 'Setting the table…' });
  await expect(pending).toBeDisabled();
  // Past the old deal's 10-second limit (but inside the Create's own) the button stays locked.
  await host.waitForTimeout(6_000);
  await expect(pending).toBeDisabled();
  releaseCreate();
  await expect(host.getByRole('button', { name: 'Copy table code' })).toBeVisible();
  await expect(host.getByRole('button', { name: 'Copy table code' })).not.toHaveText(code);
});

test('a join that times out says so and frees the button; it is never re-sent', async ({
  browser,
}) => {
  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  await host.goto('/');
  await host.getByPlaceholder('Name at the table').fill('Hosty');
  await host.getByRole('button', { name: /Create private table/ }).click();
  const code = (await host.getByRole('button', { name: 'Copy table code' }).innerText()).trim();
  await post(host, 'hold', { ms: 20000, count: 1, action: 'join' });
  let joins = 0;
  guest.on('request', (r) => {
    if (r.method() === 'POST' && r.postDataJSON()?.action === 'join') joins++;
  });
  await guest.goto(`/?table=${code}`);
  await guest.getByPlaceholder('Name at the table').fill('Guesty');
  await guest.getByRole('button', { name: 'Join table' }).click();
  await expect(guest.getByText('Not sure that went through')).toBeVisible({ timeout: 14_000 });
  await expect(guest.getByRole('button', { name: 'Join table' })).toBeEnabled();
  await guest.waitForTimeout(3_000);
  expect(joins).toBe(1);
});

test('a 409 on Deal whose recovery check is held cannot put its error on the home screen', async ({
  browser,
}) => {
  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  await host.goto('/');
  await host.getByPlaceholder('Name at the table').fill('Hosty');
  await host.getByRole('button', { name: /Create private table/ }).click();
  const code = (await host.getByRole('button', { name: 'Copy table code' }).innerText()).trim();
  await guest.goto(`/?table=${code}`);
  await guest.getByPlaceholder('Name at the table').fill('Guesty');
  await guest.getByRole('button', { name: 'Join table' }).click();
  await expect(host.getByRole('button', { name: 'Deal the cards' })).toBeEnabled({ timeout: 12_000 });

  let conflicted = false;
  let heldGet = false;
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  await host.route('**/api/game**', async (route) => {
    const req = route.request();
    if (req.method() === 'POST' && req.postDataJSON()?.action === 'start') {
      conflicted = true;
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'The table changed while you were dealing.' }),
      });
    }
    if (req.method() === 'GET' && conflicted && !heldGet) {
      heldGet = true; // the recovery check
      await released;
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'boom' }),
      }).catch(() => {});
    }
    return route.continue();
  });
  await host.getByRole('button', { name: 'Deal the cards' }).click();
  await expect.poll(() => heldGet).toBe(true);
  await host.getByRole('button', { name: 'Pasur home' }).click();
  await expect(host.getByRole('button', { name: /Create private table/ })).toBeVisible();
  release();
  await host.waitForTimeout(1500);
  await expect(host.getByRole('alert')).toHaveCount(0);
  await expect(host.getByText('The table changed while you were dealing.')).toHaveCount(0);
});

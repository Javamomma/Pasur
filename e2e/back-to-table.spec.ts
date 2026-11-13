import { test, expect } from '@playwright/test';
import { handLabels, playOneLegalCard, seatAndDeal } from './helpers';

const viewport = { width: 390, height: 664 };

/**
 * Hold the first table GET the page makes (route-level), until release(). `finished` resolves
 * once that request has really ended (answered, or cancelled by the page), plus two animation
 * frames so the page has handled the outcome.
 */
async function holdFirstGet(page: import('@playwright/test').Page) {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let ended!: () => void;
  const endedP = new Promise<void>((r) => (ended = r));
  let first: import('@playwright/test').Request | undefined;
  const end = (r: import('@playwright/test').Request) => r === first && ended();
  page.on('requestfinished', end);
  page.on('requestfailed', end);
  await page.route('**/api/game?code=*', async (route) => {
    first ??= route.request();
    await held;
    await route.continue().catch(() => {}); // the page may already have cancelled it
  });
  const finished = async () => {
    await endedP;
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
  };
  return { release, finished };
}

test('Tables then Back to your table restores the same table without a reload', async ({
  browser,
}) => {
  const hostCtx = await browser.newContext({ viewport });
  const guestCtx = await browser.newContext({ viewport });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();
  const code = await seatAndDeal(host, guest);

  const hostTurn = await host.getByText('Your turn', { exact: true }).isVisible();
  const [mover, other] = hostTurn ? [host, guest] : [guest, host];
  await playOneLegalCard(mover);
  await expect(other.getByText('Your turn', { exact: true })).toBeVisible();

  const handBefore = await handLabels(other);
  await other.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
  await other.getByRole('button', { name: 'Tables' }).click();
  const back = other.getByRole('button', { name: 'Back to your table' });
  await expect(back).toBeVisible();
  await expect(other.getByText(`Table ${code}`)).toBeVisible();
  await back.click();

  await expect(other.getByText(`Invitation-only table · ${code}`)).toBeVisible();
  expect(await handLabels(other)).toEqual(handBefore);
  expect(new URL(other.url()).searchParams.get('table')).toBe(code);
  expect(
    await other.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload),
  ).toBe(true);
  await hostCtx.close();
  await guestCtx.close();
});

test('only localStorage knows the table: the button restores it', async ({ browser }) => {
  const hostCtx = await browser.newContext({ viewport });
  const guestCtx = await browser.newContext({ viewport });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();
  const code = await seatAndDeal(host, guest);
  const handBefore = await handLabels(guest);

  // Fresh load; the automatic restore is blocked so the page rests on the join screen.
  await guest.route('**/api/game?code=*', (route) => route.abort());
  await guest.goto('/');
  await guest.getByRole('button', { name: 'Create a different table' }).click();
  const back = guest.getByRole('button', { name: 'Back to your table' });
  await expect(back).toBeVisible();
  await expect(guest.getByText(`Table ${code}`)).toBeVisible();

  // Network error keeps the button and says so.
  await back.click();
  await expect(guest.getByRole('alert')).toContainText('Connection interrupted. Try again.');
  await expect(back).toBeVisible();

  await guest.unroute('**/api/game?code=*');
  await back.click();
  await expect(guest.getByText(`Invitation-only table · ${code}`)).toBeVisible();
  expect(await handLabels(guest)).toEqual(handBefore);
  await hostCtx.close();
  await guestCtx.close();
});

test('a table the browser is no longer seated at is forgotten', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('pasur-last-table', 'ABCDEFGHJK'));
  await page.route('**/api/game?code=*', (route) => route.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a different table' }).click();
  await page.unroute('**/api/game?code=*');
  await page.getByRole('button', { name: 'Back to your table' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to your table' })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('pasur-last-table'))).toBeNull();
  await ctx.close();
});

test('a slow restore does not overwrite a table created meanwhile', async ({ browser }) => {
  const hostCtx = await browser.newContext({ viewport });
  const guestCtx = await browser.newContext({ viewport });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();
  const codeA = await seatAndDeal(host, guest);

  // Fresh load of the guest with the automatic restore blocked, then rest on home.
  await guest.route('**/api/game?code=*', (route) => route.abort());
  await guest.goto('/');
  await guest.getByRole('button', { name: 'Create a different table' }).click();
  await guest.unroute('**/api/game?code=*');

  // Hold the restore GET for table A.
  const hold = await holdFirstGet(guest);
  await guest.getByRole('button', { name: 'Back to your table' }).click();
  await expect(guest.getByRole('button', { name: 'Opening your table…' })).toBeDisabled();

  // Meanwhile create a new table B.
  await guest.getByPlaceholder('Name at the table').fill('Guesty');
  await guest.getByRole('button', { name: /Create private table/ }).click();
  const codeB = (await guest.getByRole('button', { name: 'Copy table code' }).innerText()).trim();
  expect(codeB).not.toBe(codeA);

  // Release A's reply: the page must stay on B.
  hold.release();
  await hold.finished();
  await expect(guest.getByRole('button', { name: 'Copy table code' })).toHaveText(codeB);
  expect(await guest.evaluate(() => localStorage.getItem('pasur-last-table'))).toBe(codeB);
  expect(new URL(guest.url()).searchParams.get('table')).toBe(codeB);
  await hostCtx.close();
  await guestCtx.close();
});

/** Open the page with table A stored, the initial restore GET held until `release()`. */
async function holdInitialRestore(guest: import('@playwright/test').Page) {
  const hold = await holdFirstGet(guest);
  await guest.goto('/');
  return hold;
}

test('a slow initial-load restore does not overwrite a table created meanwhile', async ({
  browser,
}) => {
  const hostCtx = await browser.newContext({ viewport });
  const guestCtx = await browser.newContext({ viewport });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();
  const codeA = await seatAndDeal(host, guest);

  const hold = await holdInitialRestore(guest);
  await guest.getByRole('button', { name: 'Create a different table' }).click();
  await guest.getByPlaceholder('Name at the table').fill('Guesty');
  await guest.getByRole('button', { name: /Create private table/ }).click();
  const codeB = (await guest.getByRole('button', { name: 'Copy table code' }).innerText()).trim();
  expect(codeB).not.toBe(codeA);

  hold.release();
  await hold.finished();
  await expect(guest.getByRole('button', { name: 'Copy table code' })).toHaveText(codeB);
  expect(await guest.evaluate(() => localStorage.getItem('pasur-last-table'))).toBe(codeB);
  expect(new URL(guest.url()).searchParams.get('table')).toBe(codeB);
  await hostCtx.close();
  await guestCtx.close();
});

test('a pending restore cannot pull the player off the join screen', async ({ browser }) => {
  const hostCtx = await browser.newContext({ viewport });
  const guestCtx = await browser.newContext({ viewport });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();
  await seatAndDeal(host, guest);

  const hold = await holdInitialRestore(guest);
  await guest.getByRole('button', { name: 'Create a different table' }).click();
  await guest.getByRole('button', { name: 'Have an invitation? Join a table' }).click();
  await expect(guest.getByRole('heading', { name: 'Join the table' })).toBeVisible();

  hold.release();
  await hold.finished();
  await expect(guest.getByRole('heading', { name: 'Join the table' })).toBeVisible();
  await expect(guest.getByRole('button', { name: 'Join table' })).toBeVisible();
  await hostCtx.close();
  await guestCtx.close();
});

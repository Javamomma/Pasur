import { expect, type Page } from '@playwright/test';

/** Wait for ANOTHER page to notice a change: it polls every 5 s in the lobby, between rounds and at the end. */
export const OTHER_PAGE_MS = 12_000;

export const handLabels = (page: Page) =>
  page
    .locator('.hand-cards button.playing-card')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || ''));

export async function playOneLegalCard(page: Page) {
  const hand = page.locator('.hand-cards button.playing-card');
  const pool = page.locator('[aria-label="Cards on the table"] button.playing-card');
  const play = page.getByRole('button', { name: /^(Play card|Capture cards)$/ });
  const n = await hand.count();
  for (let i = 0; i < n; i++) {
    await hand.nth(i).click();
    if (await play.isEnabled()) return play.click();
    // The card has capture options: try table-card combinations until the button enables.
    const m = await pool.count();
    for (let mask = 1; mask < 1 << m; mask++) {
      const picked = [...Array(m).keys()].filter((k) => mask & (1 << k));
      for (const k of picked) await pool.nth(k).click();
      if (await play.isEnabled()) return play.click();
      for (const k of picked) await pool.nth(k).click();
    }
  }
  throw new Error('No legal play found');
}

/** Create a 2-player table with `host`, join with `guest`, host deals. Returns the table code. */
export async function seatAndDeal(host: Page, guest: Page) {
  await host.goto('/');
  await host.getByPlaceholder('Name at the table').fill('Hosty');
  await host.getByRole('button', { name: /Create private table/ }).click();
  const code = (await host.getByRole('button', { name: 'Copy table code' }).innerText()).trim();
  await guest.goto(`/?table=${code}`);
  await guest.getByPlaceholder('Name at the table').fill('Guesty');
  await guest.getByRole('button', { name: 'Join table' }).click();
  await expect(guest.getByText('Waiting for the host to deal')).toBeVisible();
  await host.getByRole('button', { name: 'Deal the cards' }).click();
  await expect(host.locator('.hand-cards button.playing-card')).toHaveCount(4);
  await expect(guest.locator('.hand-cards button.playing-card')).toHaveCount(4, {
    timeout: OTHER_PAGE_MS,
  });
  return code;
}

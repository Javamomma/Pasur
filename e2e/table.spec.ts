import { test, expect } from '@playwright/test';
import { handLabels, playOneLegalCard } from './helpers';

test('two players: create, join, deal, play, reload', async ({ browser }) => {
  const hostCtx = await browser.newContext({ viewport: { width: 390, height: 664 } });
  const guestCtx = await browser.newContext({ viewport: { width: 390, height: 664 } });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  // Host creates a 2-player table.
  await host.goto('/');
  await host.getByPlaceholder('Name at the table').fill('Hosty');
  await host.getByRole('button', { name: /Create private table/ }).click();
  const code = (await host.getByRole('button', { name: 'Copy table code' }).innerText()).trim();
  expect(code).toMatch(/^[A-Z2-9]{10}$/);

  // Guest opens the invitation link and joins.
  await guest.goto(`/?table=${code}`);
  await guest.getByPlaceholder('Name at the table').fill('Guesty');
  await guest.getByRole('button', { name: 'Join table' }).click();
  await expect(guest.getByText('Waiting for the host to deal')).toBeVisible();

  // Host deals.
  const deal = host.getByRole('button', { name: 'Deal the cards' });
  await expect(deal).toBeEnabled();
  await deal.click();
  await expect(host.locator('.hand-cards button.playing-card')).toHaveCount(4);
  await expect(guest.locator('.hand-cards button.playing-card')).toHaveCount(4);

  // Privacy: the guest's page never shows the host's cards.
  const hostHand = await handLabels(host);
  const guestHand = await handLabels(guest);
  expect(hostHand).toHaveLength(4);
  for (const card of hostHand) {
    expect(guestHand).not.toContain(card);
    await expect(guest.locator(`[aria-label="${card}"]`)).toHaveCount(0);
  }
  const apiView = await (await guestCtx.request.get(`/api/game?code=${code}`)).json();
  expect(apiView.deck).toBeUndefined();
  expect(apiView.players[0].hand).toEqual([]);
  expect(JSON.stringify(apiView)).not.toMatch(/"key"/);

  // Whoever has the turn plays one legal card.
  const hostTurn = await host.getByText('Your turn', { exact: true }).isVisible();
  const [mover, other, moverName] = hostTurn ? [host, guest, 'Hosty'] : [guest, host, 'Guesty'];
  await expect(mover.getByText('Your turn', { exact: true })).toBeVisible();
  const before = await handLabels(mover);
  await playOneLegalCard(mover);

  // The other player sees the play.
  await expect(other.locator('.last-play')).toContainText(`${moverName} played`);
  await expect(other.getByText('Your turn', { exact: true })).toBeVisible();
  await expect(mover.locator('.hand-cards button.playing-card')).toHaveCount(before.length - 1);

  // Reload one page: same seat, same table, same hand.
  const handBefore = await handLabels(guest);
  await guest.reload();
  await expect(guest.locator('.hand-cards button.playing-card')).toHaveCount(handBefore.length);
  expect(await handLabels(guest)).toEqual(handBefore);
  await expect(guest.getByText(`Invitation-only table · ${code}`)).toBeVisible();
  await expect(guest.getByText('Guesty · Your hand')).toBeVisible();
});

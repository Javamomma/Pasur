import { test, expect } from '@playwright/test';

test('a render error shows the fallback with a Reload button, not a blank page', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/');
  await page.getByPlaceholder('Name at the table').fill('Hosty');
  await page.getByRole('button', { name: /Create private table/ }).click();
  await expect(page.getByRole('button', { name: 'Copy table code' })).toBeVisible();
  // The next poll gets a table that passes the page's shape check but breaks rendering
  // (a playing table whose `captured` is empty).
  await page.route('**/api/game?*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const real = await route.fetch();
    const view = await real.json();
    await route.fulfill({
      response: real,
      json: { ...view, phase: 'playing', revision: view.revision + 1000, captured: [], turn: 0 },
    });
  });
  await expect(page.getByText('Something went wrong on this page.')).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
  expect(errors.join('\n')).toContain('Pasur render error');
  await page.unroute('**/api/game?*');
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByText('Something went wrong on this page.')).toHaveCount(0);
});

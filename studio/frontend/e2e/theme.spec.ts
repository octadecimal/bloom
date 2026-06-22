import { test, expect } from '@playwright/test';
import { gotoWorkbench } from './helpers';

test('app is dark-only: html keeps the dark class, there is no theme toggle, and it persists across reload', async ({ page }) => {
  await gotoWorkbench(page);
  const html = page.locator('html');
  // Dark-only design: the document is always dark.
  await expect(html).toHaveClass(/dark/);
  // The theme toggle was removed (dark-only), so it must not be present.
  await expect(page.getByTestId('theme-toggle')).toHaveCount(0);
  // Persists across reload — re-stub routes before reload so the workbench still loads.
  await page.route('**/rooms', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'r1', name: 'Test Room', model: 'm', gameId: null, createdAt: 't' }]),
    }),
  );
  await page.route('**/rooms/*/messages', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.reload();
  await expect(html).toHaveClass(/dark/);
});

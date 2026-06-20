import { test, expect } from '@playwright/test';
import { gotoWorkbench } from './helpers';

test('theme toggle flips dark/light and persists across reload', async ({ page }) => {
  await gotoWorkbench(page);
  const html = page.locator('html');
  // Default theme is dark
  await expect(html).toHaveClass(/dark/);
  // Toggle to light
  await page.getByTestId('theme-toggle').click();
  await expect(html).not.toHaveClass(/dark/);
  // Allow the debounced saver (50 ms) to flush before we reload
  await page.waitForFunction(() => {
    const v = localStorage.getItem('bloom.studio.workspace');
    return v != null && v.includes('"theme":"light"');
  });
  // Persist: reload and still light — re-stub routes before reload so the workbench still loads.
  await page.route('**/rooms', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'r1', name: 'Test Room', model: 'm', gameId: null, createdAt: 't' }]),
    }),
  );
  await page.route('**/rooms/*/messages', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.reload();
  await expect(html).not.toHaveClass(/dark/);
});

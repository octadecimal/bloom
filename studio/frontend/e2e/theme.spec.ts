import { test, expect } from '@playwright/test';

test('theme toggle flips dark/light and persists across reload', async ({ page }) => {
  await page.goto('/');
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
  // Persist: reload and still light
  await page.reload();
  await expect(html).not.toHaveClass(/dark/);
});

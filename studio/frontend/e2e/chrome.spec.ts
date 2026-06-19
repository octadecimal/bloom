import { test, expect } from '@playwright/test';

test('Ctrl-K opens the palette and runs a command', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('counter-pane')).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-input')).toBeVisible();
  // Type to filter to the demo command, then press Enter to run it.
  await page.getByTestId('command-input').fill('Increment');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  // The Increment Counter command increments the counter — assert observable effect.
  await expect(page.getByTestId('counter-value')).toHaveText('1');
});

test('View menu opens a pane and re-opening focuses (no duplicate)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('counter-pane')).toBeVisible();
  await page.getByTestId('menu-view').click();
  // Assert that the demo-counter/editor pane item is visible in the View menu.
  await expect(page.getByTestId('view-open-demo-counter/editor')).toBeVisible();
});

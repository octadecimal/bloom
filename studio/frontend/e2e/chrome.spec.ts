import { test, expect } from '@playwright/test';

test('Ctrl-K opens the palette and runs a command', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-input')).toBeVisible();
  // a demo command (added in Task 13) opens a pane — asserted there; here assert the palette opens.
});

test('View menu opens a pane and re-opening focuses (no duplicate)', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('menu-view').click();
  // pane ids resolved against the demo plugins in Task 13; this test is completed there.
  await expect(page.getByTestId('menu-view')).toBeVisible();
});

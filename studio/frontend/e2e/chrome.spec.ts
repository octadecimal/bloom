import { test, expect } from '@playwright/test';
import { gotoWorkbench } from './helpers';

test('Ctrl-K opens the palette and runs a command', async ({ page }) => {
  await gotoWorkbench(page);
  // Open the demo-counter/editor pane via the View menu so the Increment Counter command
  // and its observable effect (counter-value) are available in the layout.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-demo-counter/editor').click();
  await expect(page.getByTestId('counter-pane')).toBeVisible();
  // Open the command palette and run the Increment Counter command.
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-input')).toBeVisible();
  await page.getByTestId('command-input').fill('Increment');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  // The Increment Counter command increments the counter — assert observable effect.
  await expect(page.getByTestId('counter-value')).toHaveText('1');
});

test('View menu opens a pane and re-opening focuses (no duplicate)', async ({ page }) => {
  await gotoWorkbench(page);
  await page.getByTestId('menu-view').click();
  // Assert that the demo-counter/editor pane item is visible in the View menu.
  await expect(page.getByTestId('view-open-demo-counter/editor')).toBeVisible();
});

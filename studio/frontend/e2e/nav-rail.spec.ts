import { test, expect } from '@playwright/test';
import { gotoWorkbench } from './helpers';

test('rail is visible and opens a closed pane', async ({ page }) => {
  await gotoWorkbench(page);
  await expect(page.getByTestId('nav-rail')).toBeVisible();
  // Default = Art layout: Math is not open (hermetic room has no game → *-no-game placeholders).
  await expect(page.getByTestId('math-no-game')).toHaveCount(0);
  await page.getByTestId('rail-open-math/viewer').click();
  await expect(page.getByTestId('math-no-game')).toBeVisible();
});

test('active tint follows the active panel', async ({ page }) => {
  await gotoWorkbench(page);
  await page.getByTestId('rail-open-math/viewer').click();
  await expect(page.getByTestId('math-no-game')).toBeVisible();
  await expect(page.getByTestId('rail-open-math/viewer')).toHaveClass(/bg-selection/);
  // Focus a different pane → the Math icon loses the tint.
  await page.getByTestId('rail-open-llm-chat/room').click();
  await expect(page.getByTestId('rail-open-math/viewer')).not.toHaveClass(/bg-selection/);
});

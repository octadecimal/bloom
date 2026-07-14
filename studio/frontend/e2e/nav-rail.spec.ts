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

test('rail expands with labels, persists across reload, collapses back', async ({ page }) => {
  await gotoWorkbench(page);
  const toggle = page.getByTestId('rail-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('rail-open-math/viewer')).not.toContainText('Math');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('rail-open-math/viewer')).toContainText('Math');
  await expect(page.getByTestId('nav-rail')).toContainText('Design');
  await expect(page.getByTestId('nav-rail')).toContainText('Art');

  await page.reload();
  await expect(page.getByTestId('workbench')).toBeVisible();
  await expect(page.getByTestId('rail-toggle')).toHaveAttribute('aria-expanded', 'true');

  await page.getByTestId('rail-toggle').click();
  await expect(page.getByTestId('rail-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('rail-open-math/viewer')).not.toContainText('Math');
});

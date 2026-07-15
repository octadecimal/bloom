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

test('expanding the rail overlays the dock without resizing it', async ({ page }) => {
  await gotoWorkbench(page);
  const dock = page.getByTestId('dock-area');
  const before = await dock.boundingBox();
  expect(before).not.toBeNull();

  await page.getByTestId('rail-toggle').click();
  await expect(page.getByTestId('nav-rail')).toContainText('Design');
  // The dock never moves or resizes — the rail expands as an overlay.
  expect(await dock.boundingBox()).toEqual(before);

  await page.getByTestId('rail-toggle').click(); // unpin; still hover-expanded until the pointer leaves
  await page.mouse.move(640, 400); // leave the rail
  await expect(page.getByTestId('rail-toggle')).toHaveAttribute('aria-expanded', 'false');
  expect(await dock.boundingBox()).toEqual(before);
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

  await page.getByTestId('rail-toggle').click(); // unpin; still hover-expanded
  await page.mouse.move(640, 400); // leave the rail
  await expect(page.getByTestId('rail-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('rail-open-math/viewer')).not.toContainText('Math');
});

test('rail expands on hover and collapses when the pointer leaves', async ({ page }) => {
  await gotoWorkbench(page);
  await expect(page.getByTestId('rail-open-math/viewer')).not.toContainText('Math');

  await page.getByTestId('nav-rail').hover();
  await expect(page.getByTestId('rail-open-math/viewer')).toContainText('Math');
  // transient peek — the pin key is never written by hover
  expect(await page.evaluate(() => localStorage.getItem('bloom.navRailExpanded'))).toBeNull();

  await page.mouse.move(640, 400);
  await expect(page.getByTestId('rail-open-math/viewer')).not.toContainText('Math');
});

test('pinning while hover-expanded survives the pointer leaving', async ({ page }) => {
  await gotoWorkbench(page);
  await page.getByTestId('nav-rail').hover();
  await page.getByTestId('rail-toggle').click();
  await page.mouse.move(640, 400);
  await expect(page.getByTestId('rail-open-math/viewer')).toContainText('Math');
  await expect(page.getByTestId('rail-toggle')).toHaveAttribute('aria-expanded', 'true');
});

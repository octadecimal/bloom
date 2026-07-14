import { test, expect } from '@playwright/test';
import { gotoWorkbench } from './helpers';

test('apply the Design built-in shows chat + GDD and drops the Art panes', async ({ page }) => {
  await gotoWorkbench(page);
  // Default = Art phase: asset board is present.
  await expect(page.getByTestId('asset-board')).toBeVisible();

  await page.getByTestId('menu-layout').click();
  await page.getByTestId('layout-apply-Design').click();

  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
  await expect(page.getByTestId('gdd-no-game')).toBeVisible();
  await expect(page.getByTestId('asset-board')).toHaveCount(0);
});

test('clicking a phase button lands that phase panes', async ({ page }) => {
  await gotoWorkbench(page);
  await page.getByTestId('phase-Math').click();

  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
  await expect(page.getByTestId('gc-no-game')).toBeVisible();
  await expect(page.getByTestId('math-no-game')).toBeVisible();
  await expect(page.getByTestId('asset-board')).toHaveCount(0);
});

test('save the current arrangement, change it, then re-apply restores it', async ({ page }) => {
  await gotoWorkbench(page);
  // Default = Art phase. Save it as "mine".
  await page.getByTestId('menu-layout').click();
  await page.getByTestId('layout-save').click();
  await page.getByTestId('save-layout-name').fill('mine');
  await page.getByTestId('save-layout-confirm').click();

  // Mutate: close the Asset Board.
  await page.evaluate(() => (window as any).__wbApi?.getPanel('assets/board')?.api.close());
  await page.getByTestId('asset-board').waitFor({ state: 'detached' });

  // Re-apply "mine" → Asset Board returns.
  await page.getByTestId('menu-layout').click();
  await page.getByTestId('layout-apply-mine').click();
  await expect(page.getByTestId('asset-board')).toBeVisible();
});

test('delete a user preset removes it from the Layout menu', async ({ page }) => {
  await gotoWorkbench(page);
  await page.getByTestId('menu-layout').click();
  await page.getByTestId('layout-save').click();
  await page.getByTestId('save-layout-name').fill('temp');
  await page.getByTestId('save-layout-confirm').click();

  // It now appears as an apply item.
  await page.getByTestId('menu-layout').click();
  await expect(page.getByTestId('layout-apply-temp')).toBeVisible();

  // Delete it.
  await page.getByTestId('layout-delete-temp').click();

  // Re-open the menu: the apply item is gone.
  await page.getByTestId('menu-layout').click();
  await expect(page.getByTestId('layout-apply-temp')).toHaveCount(0);
});

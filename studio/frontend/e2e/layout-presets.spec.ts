import { test, expect } from '@playwright/test';
import { gotoWorkbench } from './helpers';

test('apply the Focus built-in shows only the Chat Room pane', async ({ page }) => {
  await gotoWorkbench(page);
  await expect(page.getByTestId('chat-settings-pane')).toBeVisible();

  await page.getByTestId('menu-layout').click();
  await page.getByTestId('layout-apply-Focus').click();

  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
  await expect(page.getByTestId('chat-settings-pane')).toHaveCount(0);
});

test('save the current arrangement, change it, then re-apply restores it', async ({ page }) => {
  await gotoWorkbench(page);
  // Default = Chat Room + Chat Settings. Save it as "both".
  await page.getByTestId('menu-layout').click();
  await page.getByTestId('layout-save').click();
  await page.getByTestId('save-layout-name').fill('both');
  await page.getByTestId('save-layout-confirm').click();

  // Mutate: close Chat Settings.
  await page.evaluate(() => (window as any).__wbApi?.getPanel('llm-chat/settings')?.api.close());
  await page.getByTestId('chat-settings-pane').waitFor({ state: 'detached' });

  // Re-apply "both" → Chat Settings returns.
  await page.getByTestId('menu-layout').click();
  await page.getByTestId('layout-apply-both').click();
  await expect(page.getByTestId('chat-settings-pane')).toBeVisible();
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

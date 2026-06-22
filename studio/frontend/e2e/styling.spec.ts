import { test, expect, type Page } from '@playwright/test';
import { gotoWorkbench } from './helpers';

/** Open a pane via the View menu and wait for it to be attached in the DOM. */
async function openPane(page: Page, itemTestId: string, paneTestId: string) {
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId(itemTestId)).toBeVisible();
  await page.getByTestId(itemTestId).click();
  await page.getByTestId(paneTestId).waitFor({ state: 'attached' });
}

/** Activate a dockview tab by its visible text label. */
async function activateTab(page: Page, tabText: string) {
  await page.locator('.dv-tab', { hasText: tabText }).first().click();
}

test('shadcn Button renders with Tailwind utility classes applied', async ({ page }) => {
  await gotoWorkbench(page);
  // The chat composer's Send button is a primary Button; its compiled utilities
  // (bg-primary fill + the compact h-7 height) prove Tailwind built the Button variants.
  const send = page.getByTestId('chat-send');
  await expect(send).toBeVisible();
  const { bg, height } = await send.evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, height: s.height };
  });
  // bg-primary compiled to a real, non-transparent fill.
  expect(bg).not.toBe('rgba(0, 0, 0, 0)');
  expect(bg).not.toBe('transparent');
  // h-7 compiled to the compact 28px height.
  expect(height).toBe('28px');
});

test('settings pane select renders inside card chrome with token borders', async ({ page }) => {
  // Stub the models endpoint so this test is hermetic.
  await page.route('**/models', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'gpt-4o', label: 'GPT-4o', free: false }]) }),
  );
  await gotoWorkbench(page);
  // Open the settings pane via the View menu — proven pattern from panes.spec.ts.
  await openPane(page, 'view-open-llm-chat/settings', 'chat-settings-pane');
  // Activate the "Chat Settings" tab in case it shares a tab group.
  await activateTab(page, 'Chat Settings');
  const select = page.getByTestId('settings-model');
  await expect(select).toBeVisible();
  // The Select primitive applies `border border-input`; a non-zero borderTopWidth
  // confirms the Tailwind token border compiled correctly.
  const borderWidth = await select.evaluate((el) => getComputedStyle(el).borderTopWidth);
  expect(borderWidth).not.toBe('0px');
});

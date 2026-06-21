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
  const themeToggle = page.getByTestId('theme-toggle');
  await expect(themeToggle).toBeVisible();
  // variant="outline" gives the button a visible border; a non-zero borderTopWidth
  // proves that Tailwind compiled the ring/border utilities from shadcn.
  const borderWidth = await themeToggle.evaluate((el) => getComputedStyle(el).borderTopWidth);
  expect(borderWidth).not.toBe('0px');
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

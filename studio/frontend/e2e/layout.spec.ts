import { test, expect } from '@playwright/test';
import { seedLocalStorage, gotoWorkbench } from './helpers';

test('layout persists across reload and Reset re-applies default (row 8)', async ({ page }) => {
  await gotoWorkbench(page);
  // Open the scratch pane via the View menu so it's added to the layout (not in the default).
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-demo-scratch/main')).toBeVisible();
  await page.getByTestId('view-open-demo-scratch/main').click();
  await page.getByTestId('scratch-pane').waitFor({ state: 'attached' });

  // Wait for the debounced (~250ms) layout save to flush before reloading.
  await page.waitForFunction(() => {
    const val = localStorage.getItem('bloom.studio.layout');
    return val != null && val.includes('demo-scratch/main');
  });

  await page.reload();

  // Layout was persisted — scratch is still present after reload.
  await page.getByTestId('scratch-pane').waitFor({ state: 'attached' });

  // Open File menu → Reset layout.
  await page.getByTestId('menu-file').click();
  await page.getByTestId('menu-reset-layout').click();

  // After reset: DEFAULT_LAYOUT re-applies the default panes to the live dockview API.
  // The chat-room-pane (primary default) must be accessible and visible.
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();

  // Note: layoutService.reset() saves null via debounce, but DEFAULT_LAYOUT immediately
  // triggers onDidLayoutChange which re-saves the current layout. So the layout key is
  // not null after reset — the behavioral invariant is that the default panes are present.
});

test('a corrupt saved layout falls back to default without crashing (row 9)', async ({ page }) => {
  await seedLocalStorage(page, 'bloom.studio.layout', '{not valid json');
  await gotoWorkbench(page);
  // Default layout applied, no crash. New default is chat-only.
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
});

test('real drag smoke: a tab can be dragged without crashing the workbench (row 7)', async ({
  page,
}) => {
  await gotoWorkbench(page);
  // Best-effort drag of 'Chat Room' tab onto the Chat Settings pane area.
  // Dockview HTML5 drag behaviour varies by environment; the only assertion is
  // no-crash: the workbench container must still be in the DOM.
  const source = page.locator('.dv-tab', { hasText: 'Chat Room' }).first();
  const target = page.getByTestId('chat-settings-pane');
  await source.dragTo(target, { force: true });
  // Assert no crash — the workbench itself is still mounted.
  await expect(page.getByTestId('workbench')).toBeVisible();
});

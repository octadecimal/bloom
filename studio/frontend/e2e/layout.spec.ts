import { test, expect } from '@playwright/test';
import { seedLocalStorage, gotoWorkbench } from './helpers';

test('layout persists across reload and Reset restores default (row 8)', async ({ page }) => {
  await gotoWorkbench(page);

  // Close a DEFAULT pane (asset board) via __wbApi so it's missing from the layout.
  await page.evaluate(() => (window as any).__wbApi?.getPanel('assets/board')?.api.close());
  await page.getByTestId('board-no-game').waitFor({ state: 'detached' });

  // Wait for the debounced (~250ms) layout save to flush — layout must NOT include the closed pane.
  await page.waitForFunction(() => {
    const val = localStorage.getItem('bloom.studio.layout');
    return val != null && !val.includes('assets/board');
  });

  // Re-stub routes before reload so the workbench still mounts (mirrors theme.spec pattern).
  await page.route('**/rooms', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'r1', name: 'Test Room', model: 'm', gameId: null, createdAt: 't' }]),
    }),
  );
  await page.route('**/rooms/*/messages', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

  await page.reload();

  // Persistence: asset-board is STILL gone after reload (proves the closed state was saved).
  await page.getByTestId('workbench').waitFor({ state: 'visible' });
  await expect(page.getByTestId('board-no-game')).toHaveCount(0);

  // Open File menu → Reset layout.
  await page.getByTestId('menu-layout').click();
  await page.getByTestId('menu-reset-layout').click();

  // After reset: add-if-missing re-adds the asset board — proves reset re-applied the default.
  await expect(page.getByTestId('board-no-game')).toBeVisible();
});

test('a corrupt saved layout falls back to default without crashing (row 9)', async ({ page }) => {
  await seedLocalStorage(page, 'bloom.studio.layout', '{not valid json');
  await gotoWorkbench(page);
  // Default layout applied, no crash. Fallback default is the Art phase.
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
});

test('real drag smoke: a tab can be dragged without crashing the workbench (row 7)', async ({ page }) => {
  await gotoWorkbench(page);
  // Best-effort drag of 'Asset Board' tab onto the Chat Room pane area.
  // Dockview drops inactive-tab panel content from the DOM, so after the drag the two panes
  // form a tab group: both tabs are visible in the tab strip but only the active panel's
  // content element is in the DOM. Assert no crash by checking:
  //   1. The active pane content is still attached (asset-board — it becomes active).
  //   2. BOTH tab-strip entries survive (proves neither panel was accidentally closed).
  const source = page.locator('.dv-tab', { hasText: 'Asset Board' }).first();
  const target = page.getByTestId('chat-room-pane');
  await source.dragTo(target, { force: true });
  // Active panel content is attached — no crash or blank dockview.
  await page.getByTestId('board-no-game').waitFor({ state: 'attached' });
  // Both tab-strip entries survive — neither panel was accidentally closed by the drag.
  await expect(page.locator('.dv-tab', { hasText: 'Asset Board' })).toHaveCount(1);
  await expect(page.locator('.dv-tab', { hasText: 'Chat Room' })).toHaveCount(1);
});

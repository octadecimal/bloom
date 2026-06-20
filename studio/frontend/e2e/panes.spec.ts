import { test, expect, type Page } from '@playwright/test';
import { gotoWorkbench } from './helpers';

/** Open a demo pane via the View menu and wait for the pane to appear in the DOM. */
async function openDemoPane(page: Page, itemTestId: string, paneTestId: string) {
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId(itemTestId)).toBeVisible();
  await page.getByTestId(itemTestId).click();
  // Wait for the pane element to exist (it may be in an inactive tab — use attached, not visible).
  await page.getByTestId(paneTestId).waitFor({ state: 'attached' });
}

/** Activate a dockview tab by its visible text label. */
async function activateTab(page: Page, tabText: string) {
  await page.locator('.dv-tab', { hasText: tabText }).first().click();
}

test('counter increments, mirror reflects, and count persists across reload (row 5)', async ({
  page,
}) => {
  await gotoWorkbench(page);
  // Demo panes are no longer in the default layout — open them via the View menu.
  await openDemoPane(page, 'view-open-demo-counter/editor', 'counter-pane');
  await openDemoPane(page, 'view-open-demo-counter/mirror', 'mirror-pane');

  // Dockview may place mirror in the same tab group, making counter's tab inactive.
  // Activate the Counter tab so counter-pane is visible and interactive.
  await activateTab(page, 'Counter');
  await expect(page.getByTestId('counter-pane')).toBeVisible();

  await page.getByTestId('counter-inc').click();
  await page.getByTestId('counter-inc').click();
  await expect(page.getByTestId('counter-value')).toHaveText('2');

  // Activate Mirror tab to check the mirror pane text.
  await activateTab(page, 'Mirror');
  await expect(page.getByTestId('mirror-pane')).toHaveText('count is 2');

  // Wait for the 250ms debounced counter-state save to flush before reloading.
  await page.waitForFunction(() =>
    localStorage.getItem('bloom.studio.demo-counter')?.includes('"count":2'),
  );
  // Also wait for the debounced layout save to flush, so counter+mirror panes persist.
  await page.waitForFunction(() => {
    const val = localStorage.getItem('bloom.studio.layout');
    return val != null && val.includes('demo-counter/editor') && val.includes('demo-counter/mirror');
  });
  await page.reload();
  // Counter value should persist. Counter may be behind a tab; activateTab first.
  await activateTab(page, 'Counter');
  await expect(page.getByTestId('counter-value')).toHaveText('2'); // persist:true
});

test('scratch text is ephemeral across reload (row 6)', async ({ page }) => {
  await gotoWorkbench(page);
  // Open scratch pane via View menu.
  await openDemoPane(page, 'view-open-demo-scratch/main', 'scratch-pane');
  await activateTab(page, 'Scratch');
  await expect(page.getByTestId('scratch-pane')).toBeVisible();

  await page.getByTestId('scratch-input').fill('hello');
  // Wait for the layout save to flush so scratch-pane is in the persisted layout.
  await page.waitForFunction(() => {
    const val = localStorage.getItem('bloom.studio.layout');
    return val != null && val.includes('demo-scratch/main');
  });
  await page.reload();
  // Activate scratch tab (it persisted in the layout).
  await activateTab(page, 'Scratch');
  await expect(page.getByTestId('scratch-input')).toHaveValue(''); // persist:false
});

test('incrementing re-renders only counter + mirror, not scratch (row 10)', async ({ page }) => {
  await gotoWorkbench(page);
  // Open all three demo panes so render counts are trackable.
  await openDemoPane(page, 'view-open-demo-counter/editor', 'counter-pane');
  await openDemoPane(page, 'view-open-demo-counter/mirror', 'mirror-pane');
  await openDemoPane(page, 'view-open-demo-scratch/main', 'scratch-pane');

  // Activate Counter tab so counter-pane is the active/visible tab.
  await activateTab(page, 'Counter');
  await expect(page.getByTestId('counter-pane')).toBeVisible();

  // Reset counts after mount so StrictMode double-invocations don't skew results.
  await page.evaluate(() => {
    window.__renderCounts = {};
  });
  await page.getByTestId('counter-inc').click();
  const counts = await page.evaluate(() => window.__renderCounts ?? {});
  expect(counts['CounterPane'] ?? 0).toBeGreaterThanOrEqual(1);
  expect(counts['MirrorPane'] ?? 0).toBeGreaterThanOrEqual(1);
  expect(counts['ScratchPane'] ?? 0).toBe(0); // scoped subscription: scratch must not re-render
});

test('View menu opens a pane and re-opening focuses, not duplicates (row 4)', async ({ page }) => {
  await gotoWorkbench(page);
  // Open demo-scratch/main twice — should be a singleton (no duplicate).
  await openDemoPane(page, 'view-open-demo-scratch/main', 'scratch-pane');
  await openDemoPane(page, 'view-open-demo-scratch/main', 'scratch-pane');
  await expect(page.getByTestId('scratch-pane')).toHaveCount(1);
});

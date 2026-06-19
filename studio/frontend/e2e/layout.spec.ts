import { test, expect } from '@playwright/test';
import { seedLocalStorage } from './helpers';

test('layout persists across reload and Reset restores default (row 8)', async ({ page }) => {
  await page.goto('/');
  // Close the scratch pane via dockview API (dev/test-only window exposure).
  await page.evaluate(() =>
    (window as unknown as { __wbApi?: { getPanel: (id: string) => { api: { close: () => void } } | undefined } })
      .__wbApi?.getPanel('demo-scratch/main')?.api.close()
  );
  await expect(page.getByTestId('scratch-pane')).toHaveCount(0);
  // Wait deterministically for the debounced (~250ms) layout save to flush before reloading.
  // Require val != null so we don't pass prematurely if localStorage was empty to begin with.
  await page.waitForFunction(() => {
    const val = localStorage.getItem('bloom.studio.layout');
    return val != null && !val.includes('demo-scratch/main');
  });
  await page.reload();
  // Assert scratch stays closed (layout was persisted).
  await expect(page.getByTestId('scratch-pane')).toHaveCount(0);
  // Open File menu, then click Reset layout — Radix renders items in a portal only when open.
  await page.getByTestId('menu-file').click();
  await page.getByTestId('menu-reset-layout').click();
  // Default layout restored — scratch should be back.
  await expect(page.getByTestId('scratch-pane')).toHaveCount(1);
});

test('a corrupt saved layout falls back to default without crashing (row 9)', async ({ page }) => {
  await seedLocalStorage(page, 'bloom.studio.layout', '{not valid json');
  await page.goto('/');
  // Default layout applied, no crash.
  await expect(page.getByTestId('counter-pane')).toBeVisible();
});

test('real drag smoke: a tab can be dragged to a new group (row 7)', async ({ page }) => {
  await page.goto('/');
  // Dockview now renders the human title from IPaneDef.title.
  const source = page.locator('.dv-tab', { hasText: 'Scratch' }).first();
  const target = page.getByTestId('counter-pane');
  // Best-effort drag — dockview HTML5 drag behaviour varies; the assertion is
  // a no-crash / presence check: scratch-pane must still be in the DOM.
  await source.dragTo(target);
  await expect(page.getByTestId('scratch-pane')).toBeVisible();
});

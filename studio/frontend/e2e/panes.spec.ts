import { test, expect } from '@playwright/test';

test('counter increments, mirror reflects, and count persists across reload (row 5)', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('counter-inc').click();
  await page.getByTestId('counter-inc').click();
  await expect(page.getByTestId('counter-value')).toHaveText('2');
  await expect(page.getByTestId('mirror-pane')).toHaveText('count is 2');
  // Wait deterministically for the 250ms debounced save to flush before reloading.
  await page.waitForFunction(() => localStorage.getItem('bloom.studio.demo-counter')?.includes('"count":2'));
  await page.reload();
  await expect(page.getByTestId('counter-value')).toHaveText('2'); // persist:true
});

test('scratch text is ephemeral across reload (row 6)', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('scratch-input').fill('hello');
  await page.reload();
  await expect(page.getByTestId('scratch-input')).toHaveValue(''); // persist:false
});

test('incrementing re-renders only counter + mirror, not scratch (row 10)', async ({ page }) => {
  await page.goto('/');
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
  await page.goto('/');
  await expect(page.getByTestId('counter-pane')).toBeVisible();
  // Open the View menu and open demo-scratch/main, then open it again — should be a singleton.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-demo-scratch/main').click();
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-demo-scratch/main').click();
  await expect(page.getByTestId('scratch-pane')).toHaveCount(1);
});

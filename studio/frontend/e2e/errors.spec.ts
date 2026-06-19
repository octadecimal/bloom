import { test, expect } from '@playwright/test';

test('a plugin whose init throws is skipped; the workbench still boots (row 11)', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __injectPlugins?: unknown[] }).__injectPlugins = [
      { id: 'bad', title: 'Bad', panes: [], init: () => { throw new Error('boom'); } },
    ];
  });
  await page.goto('/');
  await expect(page.getByTestId('counter-pane')).toBeVisible(); // good plugins still loaded
});

test('a corrupt persisted plugin slice falls back to initialState (row 12)', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('bloom.studio.demo-counter', '{bad json'));
  await page.goto('/');
  await expect(page.getByTestId('counter-value')).toHaveText('0'); // initialState, no crash
});

test('an unknown command id is a no-op, no crash (row 13)', async ({ page }) => {
  await page.goto('/');
  const ok = await page.evaluate(() => {
    try {
      (window as unknown as { __host?: { runCommand(id: string): void } }).__host?.runCommand('does/not-exist');
      return true;
    } catch {
      return false;
    }
  });
  expect(ok).toBe(true);
  await expect(page.getByTestId('counter-pane')).toBeVisible();
});

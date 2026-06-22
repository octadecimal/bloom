import { test, expect } from '@playwright/test';
import { gotoWorkbench } from './helpers';

test('app is dark-only: html keeps the dark class, there is no theme toggle, and it persists across reload', async ({ page }) => {
  await gotoWorkbench(page);
  const html = page.locator('html');
  // Dark-only design: the document is always dark.
  await expect(html).toHaveClass(/dark/);
  // The theme toggle was removed (dark-only), so it must not be present.
  await expect(page.getByTestId('theme-toggle')).toHaveCount(0);
  // Persists across reload — re-stub routes before reload so the workbench still loads.
  await page.route('**/rooms', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'r1', name: 'Test Room', model: 'm', gameId: null, createdAt: 't' }]),
    }),
  );
  await page.route('**/rooms/*/messages', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.reload();
  await expect(html).toHaveClass(/dark/);
});

test('docked groups are floating hairline cards on the canvas', async ({ page }) => {
  await gotoWorkbench(page);
  const group = page.locator('.dockview-theme-bloom .dv-groupview').first();
  await expect(group).toBeVisible();
  const { radius, borderColor, borderWidth } = await group.evaluate((el) => {
    const s = getComputedStyle(el);
    return { radius: s.borderTopLeftRadius, borderColor: s.borderTopColor, borderWidth: s.borderTopWidth };
  });
  expect(radius).toBe('9px');
  expect(borderWidth).toBe('1px');
  // hairline = rgba(255,255,255,0.07)
  expect(borderColor.replace(/\s/g, '')).toBe('rgba(255,255,255,0.07)');
});

test('the canvas token is the near-black app background', async ({ page }) => {
  await gotoWorkbench(page);
  const canvas = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim());
  expect(canvas).toBe('#08090a');
});

test('reference screenshot of the workbench (committed fidelity artifact)', async ({ page }) => {
  await gotoWorkbench(page);
  await page.setViewportSize({ width: 1440, height: 720 });
  await page.screenshot({ path: 'docs/design-language/reference-workbench.png' });
});

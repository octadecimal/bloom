import { test, expect } from '@playwright/test';

test('shadcn Button renders with Tailwind utility classes applied', async ({ page }) => {
  await page.goto('/');
  const btn = page.getByTestId('probe-button');
  await expect(btn).toBeVisible();
  // Tailwind applied a non-transparent background (the primary token), proving the pipeline works.
  const bg = await btn.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe('rgba(0, 0, 0, 0)');
});

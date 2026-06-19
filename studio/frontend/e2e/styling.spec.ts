import { test, expect } from '@playwright/test';

test('shadcn Button renders with Tailwind utility classes applied', async ({
  page,
}) => {
  await page.goto('/');
  const themeToggle = page.getByTestId('theme-toggle');
  await expect(themeToggle).toBeVisible();
  // variant="outline" gives the button a visible border; a non-zero borderTopWidth
  // proves that Tailwind compiled the ring/border utilities from shadcn.
  const borderWidth = await themeToggle.evaluate(
    (el) => getComputedStyle(el).borderTopWidth,
  );
  expect(borderWidth).not.toBe('0px');
});

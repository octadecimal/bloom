import { test, expect } from '@playwright/test';

test('workbench boots and renders the app root', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('workbench')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Bloom Studio' })).toBeVisible();
});

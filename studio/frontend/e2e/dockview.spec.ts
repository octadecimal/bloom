import { test, expect } from '@playwright/test';

test('the docking surface mounts and shows the default pane', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('counter-pane')).toBeVisible();
});

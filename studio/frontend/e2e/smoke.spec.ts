import { test, expect } from '@playwright/test';
import { seedLocalStorage } from './helpers';

test('logged-in deep-link boots the workbench', async ({ page }) => {
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username: 'ada' } }));
  await page.route('**/rooms', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'r1', name: 'A', model: 'm', gameId: null, createdAt: 't' }]),
    }),
  );
  await page.route('**/rooms/*/messages', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.goto('/room/r1');
  await expect(page.getByTestId('workbench')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Bloom Studio' })).toBeVisible();
});

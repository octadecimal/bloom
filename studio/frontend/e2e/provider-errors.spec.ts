// studio/frontend/e2e/provider-errors.spec.ts
import { test, expect } from '@playwright/test';
import { seedLocalStorage } from './helpers';

const BACKEND_URL = process.env.VITE_BLOOM_BACKEND_URL ?? 'http://localhost:8000';

// A provider failure must surface a VISIBLE error, not a frozen "generating" state.
// The room is created with the sentinel model id, which both the replay provider
// (raises) and live OpenRouter (rejects) turn into the backend's `error` event.
test('a failed generation shows a visible chat error, not a frozen state', async ({ page, request }) => {
  const room = await request.post(`${BACKEND_URL}/rooms`, { data: { name: `Err ${Date.now()}`, model: 'bloom/force-error' } }).then((r) => r.json());

  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username: 'alice' } }));
  await page.goto(`/room/${room.id}`);
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();

  await page.getByTestId('chat-composer').fill('this will fail');
  await page.getByTestId('chat-send').click();

  await expect(page.getByTestId('chat-error')).toBeVisible({ timeout: 15_000 });
  // and the AI status must not be stuck generating
  await expect(page.getByTestId('chat-ai-status')).not.toHaveAttribute('data-state', 'generating', { timeout: 15_000 });
});

import { expect, type Page } from '@playwright/test';

const offset = Number(process.env.BLOOM_PORT_OFFSET ?? 0) || 0;
/** Backend base URL for direct Node-side API calls from specs — follows BLOOM_PORT_OFFSET. */
export const BACKEND_URL = process.env.VITE_BLOOM_BACKEND_URL ?? `http://localhost:${8000 + offset}`;

export async function seedLocalStorage(page: Page, key: string, value: string) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [key, value]);
}

/**
 * Navigate to the workbench for a given room, fully hermetic:
 * - Seeds the session in localStorage.
 * - Stubs GET /rooms and GET /rooms/:id/messages so no live backend is needed.
 * - Navigates to /room/:roomId.
 * - Waits until data-testid="workbench" is visible.
 */
export async function gotoWorkbench(page: Page, opts: { username?: string; roomId?: string; rooms?: unknown[] } = {}) {
  const { username = 'ada', roomId = 'r1' } = opts;
  const rooms = opts.rooms ?? [{ id: roomId, name: 'Test Room', model: 'm', gameId: null, createdAt: 't' }];
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.route('**/rooms', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rooms) }));
  await page.route('**/rooms/*/messages', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.goto(`/room/${roomId}`);
  await expect(page.getByTestId('workbench')).toBeVisible();
}

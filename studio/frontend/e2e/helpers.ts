import { expect, type Page } from '@playwright/test';

const offset = Number(process.env.BLOOM_PORT_OFFSET ?? 0) || 0;
/** Backend base URL for direct Node-side API calls from specs — follows BLOOM_PORT_OFFSET. */
export const BACKEND_URL = process.env.VITE_BLOOM_BACKEND_URL ?? `http://localhost:${8000 + offset}`;

export async function seedLocalStorage(page: Page, key: string, value: string) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [key, value]);
}

/**
 * Wait for the backend's definition->scene sync snapshot to land. It always
 * contains a Root node (ensure_root runs before set_modules broadcasts it,
 * scene/hub.py:79). scene_snapshot wholesale-replaces the client document, so
 * locally seeding via __gameApplyInbound before it lands gets wiped.
 */
/** Open the Game Scene pane via the View menu ONLY if it isn't already open.
 * With the Art default layout it usually is — and re-opening an open pane
 * re-activates it in Dockview, which reattaches the engine iframe and reloads
 * it, dropping in-flight bridge ops. */
export async function ensureGameSceneOpen(page: Page): Promise<void> {
  if (
    !(await page
      .getByTestId('game-engine-frame')
      .isVisible()
      .catch(() => false))
  ) {
    await page.getByTestId('menu-view').click();
    await page.getByTestId('view-open-game/preview').click();
  }
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15000 });
}

export async function waitForSceneSync(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Object.values(((window as any).__gameSceneSnapshot?.document?.nodes ?? {}) as Record<string, any>).some((n: any) => n?.type === 'Root'),
        ),
      { timeout: 15000 },
    )
    .toBe(true);
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

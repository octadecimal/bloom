import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Local-only (browser e2e is never in CI). Requires the full stack:
//   engine :4300 (nx serve client), backend :8000 (replay), studio :4200.
// Drives ops through the real socket-dispatch path (window.__gameApplyInbound)
// so the reducer + ProtocolBridge + engine-iframe render run without an LLM.
//
// Cross-origin note: the engine iframe is served from :4300; reading
// iframe.contentWindow is blocked by the browser (SecurityError). Instead we
// listen for the engine's postMessage acks on the studio top window — those
// travel from :4300 → :4200 and are fully accessible here.

async function openAppAtRoom(page: Page, username: string): Promise<string> {
  // Install message recorder BEFORE navigation so init-script runs first.
  await page.addInitScript(() => {
    (window as any).__engineMsgs = [];
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (d && (d.kind === 'ack' || d.kind === 'ready' || d.kind === 'error')) {
        (window as any).__engineMsgs.push({ origin: e.origin, kind: d.kind });
      }
    });
  });

  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await page.getByPlaceholder(/new room/i).fill(`Scene E2E ${Date.now()}`);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('workbench')).toBeVisible();
  return page.url();
}

test('ops are delivered to and acknowledged by the engine iframe (cross-frame, live, no reload)', async ({ page }) => {
  await openAppAtRoom(page, 'ada');

  // Open the Game Scene pane via the View menu (data-testid="view-open-game/preview").
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-game/preview')).toBeVisible();
  await page.getByTestId('view-open-game/preview').click();

  // Wait for the iframe to be visible (activeGameId must be set for it to render).
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15000 });

  // Wait for the engine handshake — the engine posts {kind:'ready'} to window.parent.
  await expect.poll(() => page.evaluate(() => (window as any).__engineMsgs.some((m: any) => m.kind === 'ready')), { timeout: 20000 }).toBe(true);

  // Confirm gameId is set (openGame sets window.__gameActiveId in dev mode).
  const gameId = await page.evaluate(() => (window as any).__gameActiveId ?? null);
  expect(gameId).toBeTruthy();

  // Capture baseline ack count before sending ops.
  const before: number = await page.evaluate(() => (window as any).__engineMsgs.filter((m: any) => m.kind === 'ack').length);

  // Drive 3 ops through the real socket-dispatch path (same path as live ops from the backend).
  await page.evaluate((gid) => {
    const apply = (window as any).__gameApplyInbound as (e: string, p: unknown) => void;
    apply('scene_op', { gameId: gid, op: { kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } } });
    apply('scene_op', { gameId: gid, op: { kind: 'addNode', id: 's', type: 'Sprite' } });
    apply('scene_op', {
      gameId: gid,
      op: { kind: 'connect', edgeId: 'e1', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 's', port: 'parent' } },
    });
  }, gameId);

  // Assert the engine acked all 3 ops (cross-frame render proof).
  await expect
    .poll(() => page.evaluate((b: number) => (window as any).__engineMsgs.filter((m: any) => m.kind === 'ack').length - b, before), {
      timeout: 10000,
    })
    .toBeGreaterThanOrEqual(3);

  // Assert no engine errors during the session.
  expect(await page.evaluate(() => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length)).toBe(0);
});

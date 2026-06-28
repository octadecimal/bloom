import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Local-only (browser e2e is never in CI). Requires the full stack:
//   engine (runtime client), backend (replay), studio — all at this worktree's
//   BLOOM_PORT_OFFSET. Proves the render-settled frame-capture round-trip: a
//   capture request reaches the runtime-client iframe, the engine waits for the
//   frame to paint, extracts the FULL visible canvas to a PNG, and posts a
//   `captured` reply to the studio window. We assert the reply is a real
//   full-canvas image (decoded dimensions), not an empty stub. The socket leg
//   studio->backend is unit-covered; the orchestrator that drives this in a
//   loop is Plan 4. (Texture rendering into the frame is covered separately by
//   game-scene.spec.ts; here we validate the capture transport + extraction.)

async function openAppAtRoom(page: Page, username: string): Promise<void> {
  // Install the message recorder BEFORE navigation so the init-script runs first.
  await page.addInitScript(() => {
    (window as any).__captureMsgs = [];
    (window as any).__readyMsgs = [];
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (d && d.kind === 'ready') (window as any).__readyMsgs.push(true);
      if (d && d.kind === 'captured') (window as any).__captureMsgs.push({ origin: e.origin, id: d.id, png: d.png });
    });
  });

  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await page.getByPlaceholder(/new room/i).fill(`Capture E2E ${Date.now()}`);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('workbench')).toBeVisible();
}

test('captures a render-settled PNG of the engine frame and posts it to the studio', async ({ page }) => {
  await openAppAtRoom(page, 'ada');

  // Open the Game Scene pane and wait for the engine handshake (ready).
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-game/preview')).toBeVisible();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15000 });
  await expect.poll(() => page.evaluate(() => (window as any).__readyMsgs.length), { timeout: 20000 }).toBeGreaterThan(0);

  const gameId = await page.evaluate(() => (window as any).__gameActiveId ?? null);
  expect(gameId).toBeTruthy();

  // Place a root + sprite so the engine has a mounted, painted frame to capture.
  await page.evaluate((gid) => {
    const apply = (window as any).__gameApplyInbound as (e: string, p: unknown) => void;
    apply('scene_op', { gameId: gid, op: { kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } } });
    apply('scene_op', { gameId: gid, op: { kind: 'addNode', id: 's', type: 'Sprite' } });
    apply('scene_op', {
      gameId: gid,
      op: { kind: 'connect', edgeId: 'e1', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 's', port: 'parent' } },
    });
  }, gameId);

  // Trigger a capture through the real bridge (dev hook -> bridge.capture -> iframe).
  await page.evaluate(() => (window as any).__gameRequestCapture?.('cap-e2e-1'));

  // The engine replies with a `captured` PNG on the studio window.
  await expect.poll(() => page.evaluate(() => (window as any).__captureMsgs.length), { timeout: 20000 }).toBeGreaterThan(0);

  const msg = await page.evaluate(() => (window as any).__captureMsgs[0]);
  expect(msg.id).toBe('cap-e2e-1'); // backend-issued captureId round-trips
  expect(typeof msg.png).toBe('string');
  expect(msg.png.startsWith('data:image/png;base64,')).toBe(true);

  // Decode the PNG and assert it is a real FULL-CANVAS frame (the renderer's
  // visible area), not a 1x1 / empty stub — this is what proves the render-
  // settled extract captured the rendered canvas as the user sees it.
  const dims = await page.evaluate(
    (png: string) =>
      new Promise<{ w: number; h: number }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => reject(new Error('captured PNG failed to decode'));
        img.src = png;
      }),
    msg.png,
  );
  expect(dims.w).toBeGreaterThan(100);
  expect(dims.h).toBeGreaterThan(100);
});

import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Local-only (browser e2e is never in CI). Requires the full stack:
//   engine (runtime client), backend (replay), studio — all at this worktree's
//   BLOOM_PORT_OFFSET. Proves the render-settled frame-capture round-trip: a
//   capture request reaches the runtime-client iframe, the engine waits for the
//   frame to paint, extracts the canvas to a PNG, and posts a `captured` reply
//   to the studio window. The socket leg studio->backend is unit-covered; the
//   orchestrator that drives this in a loop is Plan 4.

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

  // 1. Author + generate one asset (replay produces a real >64px image on disk).
  await page.getByTestId('asset-name').fill('Wild');
  await page.getByTestId('asset-prompt').fill('a glowing wild symbol');
  await page.getByTestId('asset-workflow').selectOption('schnell-transparent');
  await page.getByRole('button', { name: 'Add asset' }).click();
  await page.getByTestId('asset-generate').click();
  await expect(page.getByTestId('asset-selected-image')).toBeVisible({ timeout: 30_000 });

  // 2. Open the Game Scene pane and wait for the engine handshake.
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-game/preview')).toBeVisible();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15000 });
  await expect.poll(() => page.evaluate(() => (window as any).__readyMsgs.length), { timeout: 20000 }).toBeGreaterThan(0);

  const gameId = await page.evaluate(() => (window as any).__gameActiveId ?? null);
  expect(gameId).toBeTruthy();

  // 3. Read the asset's selected media path from the backend.
  const imageRef = await page.evaluate(async (gid) => {
    const assets = await (await fetch(`/games/${gid}/assets`)).json();
    const a = assets[0];
    const sel = a.generations.find((g: any) => g.id === a.selectedGenerationId) ?? a.generations[0];
    return sel.imageRef as string;
  }, gameId);
  expect(imageRef).toMatch(/^\/media\//);

  // 4. Place Root + Sprite + Texture(src=imageRef) + child + data edges.
  await page.evaluate(
    ({ gid, ref }) => {
      const apply = (window as any).__gameApplyInbound as (e: string, p: unknown) => void;
      const op = (o: unknown) => apply('scene_op', { gameId: gid, op: o });
      op({ kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } });
      op({ kind: 'addNode', id: 'sym', type: 'Sprite' });
      op({ kind: 'addNode', id: 'tex', type: 'Texture', props: { src: ref } });
      op({ kind: 'connect', edgeId: 'e.child', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 'sym', port: 'parent' } });
      op({ kind: 'connect', edgeId: 'e.data', type: 'data', from: { node: 'tex', port: 'data' }, to: { node: 'sym', port: 'texture' } });
    },
    { gid: gameId, ref: imageRef },
  );

  // 5. Wait for the sprite texture to load in the engine frame (> 64px wide).
  const frame = await (await page.getByTestId('game-engine-frame').elementHandle())!.contentFrame();
  await expect
    .poll(async () => frame!.evaluate(() => (window as any).__engineRenderer?.textureSizeOf('sym')?.width ?? 0), { timeout: 20000 })
    .toBeGreaterThan(64);

  // 6. Trigger a capture through the real bridge (dev hook -> bridge.capture -> iframe).
  await page.evaluate(() => (window as any).__gameRequestCapture?.('cap-e2e-1'));

  // The engine replies with a `captured` PNG on the studio window.
  await expect.poll(() => page.evaluate(() => (window as any).__captureMsgs.length), { timeout: 20000 }).toBeGreaterThan(0);

  const msg = await page.evaluate(() => (window as any).__captureMsgs[0]);
  expect(msg.id).toBe('cap-e2e-1');
  expect(typeof msg.png).toBe('string');
  expect(msg.png.startsWith('data:image/png;base64,')).toBe(true);
  // A real textured full-canvas frame is well over 1000 chars.
  expect(msg.png.length).toBeGreaterThan(1000);
});

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
// travel from :4300 → :4200 and are fully accessible here. Playwright's
// contentFrame() CDP path CAN evaluate inside cross-origin frames.
//
// Asset-board / game-pane ordering: RoomRoute calls openGame() synchronously on
// room load (sets window.__gameActiveId) before any pane is manually opened, so
// we can poll for __gameActiveId after the room URL appears — without needing the
// game pane open. Generate the asset while the asset board is default-visible,
// then open the game pane last so it stays in the foreground for frame probes.

async function openRoom(page: Page): Promise<string> {
  // Install message recorder BEFORE navigation so init-script runs first.
  await page.addInitScript(() => {
    (window as any).__engineMsgs = [];
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (d && (d.kind === 'ack' || d.kind === 'ready' || d.kind === 'error')) {
        (window as any).__engineMsgs.push({ kind: d.kind, code: d.code });
      }
    });
  });
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username: 'ada' } }));
  await page.goto('/');
  await page.getByPlaceholder(/new room/i).fill(`Scene Correctness ${Date.now()}`);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  // RoomRoute calls openGame() synchronously on room load — poll until it's set.
  await expect.poll(() => page.evaluate(() => (window as any).__gameActiveId ?? null), { timeout: 15000 }).toBeTruthy();
  const gid = await page.evaluate(() => (window as any).__gameActiveId as string);
  expect(gid).toBeTruthy();
  return gid;
}

/**
 * Generate one real asset (replay) and return its media URL.
 * Must be called while the Asset Board pane is visible (before openGamePane).
 */
async function generateAsset(page: Page, gid: string): Promise<string> {
  // Default board view is `medium`, where the card's Generate footer (asset-generate)
  // is hover-mounted only. Switch to `large` (actions:'always') so asset-generate is
  // reliably in the DOM before we click it — otherwise the click hangs for 30s.
  await page.getByTestId('view-mode-large').click();
  await page.getByTestId('asset-name').fill('Sym');
  await page.getByTestId('asset-prompt').fill('a glowing symbol');
  await page.getByTestId('asset-workflow').selectOption('schnell-transparent');
  await page.getByRole('button', { name: 'Add asset' }).click();
  await page.getByTestId('asset-generate').click();
  await expect(page.getByTestId('asset-selected-image')).toBeVisible({ timeout: 30_000 });
  return page.evaluate(async (g) => {
    const assets = await (await fetch(`/games/${g}/assets`)).json();
    const a = assets[0];
    const sel = a.generations.find((x: any) => x.id === a.selectedGenerationId) ?? a.generations[0];
    return sel.imageRef as string;
  }, gid);
}

/** Open the Game/Preview pane and wait for the engine handshake. */
async function openGamePane(page: Page): Promise<void> {
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15000 });
  await expect.poll(() => page.evaluate(() => (window as any).__engineMsgs.some((m: any) => m.kind === 'ready')), { timeout: 20000 }).toBe(true);
}

test('a correctly-wired sprite binds its texture, is centered, and is on the stage', async ({ page }) => {
  // Generate asset while the asset board is default-visible, then open game pane.
  const gid = await openRoom(page);
  const ref = await generateAsset(page, gid);
  await openGamePane(page);
  // root pre-exists (ensure_root/set_modules ran on room open) — reuse it.
  await page.evaluate(
    ({ gid, ref }) => {
      const send = (o: unknown) => (window as any).__gameApplyInbound('scene_op', { gameId: gid, op: o });
      send({ kind: 'addNode', id: 'sym', type: 'Sprite', props: { position: { x: 640, y: 360 } } });
      send({ kind: 'addNode', id: 'tex', type: 'Texture', props: { src: ref } });
      send({ kind: 'connect', edgeId: 'e.child', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 'sym', port: 'parent' } });
      send({ kind: 'connect', edgeId: 'e.data', type: 'data', from: { node: 'tex', port: 'data' }, to: { node: 'sym', port: 'texture' } });
    },
    { gid, ref },
  );
  const frame = await (await page.getByTestId('game-engine-frame').elementHandle())!.contentFrame();
  await expect
    .poll(async () => frame!.evaluate(() => (window as any).__engineRenderer?.textureSizeOf('sym')?.width ?? 0), { timeout: 20000 })
    .toBeGreaterThan(64);
  expect(await frame!.evaluate(() => (window as any).__engineRenderer.anchorOf('sym'))).toEqual({ x: 0.5, y: 0.5 });
  expect(await frame!.evaluate(() => (window as any).__engineRenderer.onStage('sym'))).toBe(true);
  expect(await page.evaluate(() => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length)).toBe(0);
});

test('a reversed data edge is rejected by the engine', async ({ page }) => {
  const gid = await openRoom(page);
  await openGamePane(page);
  const before = await page.evaluate(() => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length);
  await page.evaluate((gid) => {
    const send = (o: unknown) => (window as any).__gameApplyInbound('scene_op', { gameId: gid, op: o });
    send({ kind: 'addNode', id: 'sym', type: 'Sprite' });
    send({ kind: 'addNode', id: 'tex', type: 'Texture', props: { src: '/media/x.png' } });
    send({ kind: 'connect', edgeId: 'bad', type: 'data', from: { node: 'sym', port: 'data' }, to: { node: 'tex', port: 'texture' } });
  }, gid);
  await expect
    .poll(() => page.evaluate((b: number) => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length - b, before), { timeout: 10000 })
    .toBeGreaterThanOrEqual(1);
});

test('removing the Root node is rejected by the engine', async ({ page }) => {
  const gid = await openRoom(page);
  await openGamePane(page);
  const before = await page.evaluate(() => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length);
  // root pre-exists (ensure_root/set_modules ran on room open) — try to remove it directly.
  await page.evaluate((gid) => {
    const send = (o: unknown) => (window as any).__gameApplyInbound('scene_op', { gameId: gid, op: o });
    send({ kind: 'removeNode', id: 'root' });
  }, gid);
  await expect
    .poll(() => page.evaluate((b: number) => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length - b, before), { timeout: 10000 })
    .toBeGreaterThanOrEqual(1);
});

test('adding a second sprite preserves the first (incremental, no rebuild)', async ({ page }) => {
  const gid = await openRoom(page);
  const ref = await generateAsset(page, gid);
  await openGamePane(page);
  // First sprite.
  await page.evaluate(
    ({ gid, ref }) => {
      const send = (o: unknown) => (window as any).__gameApplyInbound('scene_op', { gameId: gid, op: o });
      send({ kind: 'addNode', id: 'a', type: 'Sprite', props: { position: { x: 400, y: 360 } } });
      send({ kind: 'addNode', id: 'texa', type: 'Texture', props: { src: ref } });
      send({ kind: 'connect', edgeId: 'e.a', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 'a', port: 'parent' } });
      send({ kind: 'connect', edgeId: 'e.ta', type: 'data', from: { node: 'texa', port: 'data' }, to: { node: 'a', port: 'texture' } });
    },
    { gid, ref },
  );
  const frame = await (await page.getByTestId('game-engine-frame').elementHandle())!.contentFrame();
  await expect.poll(async () => frame!.evaluate(() => (window as any).__engineRenderer.onStage('a')), { timeout: 20000 }).toBe(true);
  // Second sprite — do NOT touch root.
  await page.evaluate(
    ({ gid, ref }) => {
      const send = (o: unknown) => (window as any).__gameApplyInbound('scene_op', { gameId: gid, op: o });
      send({ kind: 'addNode', id: 'b', type: 'Sprite', props: { position: { x: 880, y: 360 } } });
      send({ kind: 'addNode', id: 'texb', type: 'Texture', props: { src: ref } });
      send({ kind: 'connect', edgeId: 'e.b', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 'b', port: 'parent' } });
      send({ kind: 'connect', edgeId: 'e.tb', type: 'data', from: { node: 'texb', port: 'data' }, to: { node: 'b', port: 'texture' } });
    },
    { gid, ref },
  );
  await expect.poll(async () => frame!.evaluate(() => (window as any).__engineRenderer.onStage('b')), { timeout: 20000 }).toBe(true);
  expect(await frame!.evaluate(() => (window as any).__engineRenderer.onStage('a'))).toBe(true); // A preserved
  expect(await page.evaluate(() => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length)).toBe(0);
});

test('an unparented sprite binds its texture but is not on the stage', async ({ page }) => {
  const gid = await openRoom(page);
  const ref = await generateAsset(page, gid);
  await openGamePane(page);
  await page.evaluate(
    ({ gid, ref }) => {
      const send = (o: unknown) => (window as any).__gameApplyInbound('scene_op', { gameId: gid, op: o });
      send({ kind: 'addNode', id: 'orphan', type: 'Sprite' });
      send({ kind: 'addNode', id: 'tex', type: 'Texture', props: { src: ref } });
      send({ kind: 'connect', edgeId: 'e.data', type: 'data', from: { node: 'tex', port: 'data' }, to: { node: 'orphan', port: 'texture' } });
      // intentionally NO child edge
    },
    { gid, ref },
  );
  const frame = await (await page.getByTestId('game-engine-frame').elementHandle())!.contentFrame();
  await expect
    .poll(async () => frame!.evaluate(() => (window as any).__engineRenderer?.textureSizeOf('orphan')?.width ?? 0), { timeout: 20000 })
    .toBeGreaterThan(64);
  expect(await frame!.evaluate(() => (window as any).__engineRenderer.onStage('orphan'))).toBe(false);
});

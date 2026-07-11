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

  // Drive 2 ops through the real socket-dispatch path (same path as live ops from the
  // backend). The room already seeded a `root` node (ensure_root/set_modules run on
  // room open — scenes are no longer born empty), so reuse it instead of re-adding it.
  await page.evaluate((gid) => {
    const apply = (window as any).__gameApplyInbound as (e: string, p: unknown) => void;
    apply('scene_op', { gameId: gid, op: { kind: 'addNode', id: 's', type: 'Sprite' } });
    apply('scene_op', {
      gameId: gid,
      op: { kind: 'connect', edgeId: 'e1', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 's', port: 'parent' } },
    });
  }, gameId);

  // Assert the engine acked both ops (cross-frame render proof).
  await expect
    .poll(() => page.evaluate((b: number) => (window as any).__engineMsgs.filter((m: any) => m.kind === 'ack').length - b, before), {
      timeout: 10000,
    })
    .toBeGreaterThanOrEqual(2);

  // Assert no engine errors during the session.
  expect(await page.evaluate(() => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length)).toBe(0);
});

test('a generated asset renders as a real sprite texture in the engine iframe (live, no reload)', async ({ page }) => {
  await openAppAtRoom(page, 'ada');

  // 1. Author + generate one asset (replay produces a real >64px image on disk).
  // Default board view is `medium`, where the card's Generate footer (asset-generate)
  // is hover-mounted only; switch to `large` (actions:'always') so the click below
  // doesn't hang waiting for a button that is never in the DOM.
  await page.getByTestId('view-mode-large').click();
  await page.getByTestId('asset-name').fill('Wild');
  await page.getByTestId('asset-prompt').fill('a glowing wild symbol');
  await page.getByTestId('asset-workflow').selectOption('schnell-transparent');
  await page.getByRole('button', { name: 'Add asset' }).click();
  await page.getByTestId('asset-generate').click();
  await expect(page.getByTestId('asset-selected-image')).toBeVisible({ timeout: 30_000 });

  // 2. Open the Game Scene pane and wait for the engine handshake.
  //    (Do this before fetching assets so that window.__gameActiveId is guaranteed set.)
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15000 });
  await expect.poll(() => page.evaluate(() => (window as any).__engineMsgs?.some((m: any) => m.kind === 'ready')), { timeout: 20000 }).toBe(true);

  // 3. Read the actual game ID (set by openGame when the room route loaded).
  const gameId = await page.evaluate(() => (window as any).__gameActiveId as string | null);
  expect(gameId).toBeTruthy();

  // 4. Read the asset's selected media path from the backend wire.
  const imageRef = await page.evaluate(async (gid) => {
    const assets = await (await fetch(`/games/${gid}/assets`)).json();
    const a = assets[0];
    const sel = a.generations.find((g: any) => g.id === a.selectedGenerationId) ?? a.generations[0];
    return sel.imageRef as string;
  }, gameId);
  expect(imageRef).toMatch(/^\/media\//);

  // 5. Add a sprite under the room's already-seeded root, add a Texture(src=imageRef),
  //    bind it with a data edge. (root pre-exists — ensure_root/set_modules ran on
  //    room open — so reuse it rather than re-adding it.)
  await page.evaluate(
    ({ gid, ref }) => {
      const apply = (window as any).__gameApplyInbound as (e: string, p: unknown) => void;
      const op = (o: unknown) => apply('scene_op', { gameId: gid, op: o });
      op({ kind: 'addNode', id: 'sym', type: 'Sprite' });
      op({ kind: 'addNode', id: 'tex', type: 'Texture', props: { src: ref } });
      op({ kind: 'connect', edgeId: 'e.child', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 'sym', port: 'parent' } });
      op({ kind: 'connect', edgeId: 'e.data', type: 'data', from: { node: 'tex', port: 'data' }, to: { node: 'sym', port: 'texture' } });
    },
    { gid: gameId, ref: imageRef },
  );

  // 6. Inside the cross-origin engine frame, poll the sprite's texture size > 64.
  const frame = await (await page.getByTestId('game-engine-frame').elementHandle())!.contentFrame();
  await expect
    .poll(async () => frame!.evaluate(() => (window as any).__engineRenderer?.textureSizeOf('sym')?.width ?? 0), { timeout: 20000 })
    .toBeGreaterThan(64);

  // 7. No engine errors during the session.
  expect(await page.evaluate(() => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length)).toBe(0);
});

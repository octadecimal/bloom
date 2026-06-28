import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Local-only (browser e2e never runs in CI). Requires the full replay stack:
//   engine :4300, backend :8000 (replay), studio :4200 — honor BLOOM_PORT_OFFSET.
// Proves the Asset Board → live game path end-to-end: regenerate auto-selects the
// newest variant and variant-toggle re-selects, each rewriting the bound Texture's
// src in the studio-synced scene document and re-rendering the engine iframe.

async function openAppAtRoom(page: Page, username: string): Promise<void> {
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
  await page.getByPlaceholder(/new room/i).fill(`Variant Sync ${Date.now()}`);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('workbench')).toBeVisible();
}

function texSrc(page: Page, texId: string) {
  return page.evaluate((tid) => {
    const doc = (window as any).__gameSceneDocument as { nodes: Record<string, any> } | undefined;
    return doc?.nodes?.[tid]?.props?.src ?? null;
  }, texId);
}

test('regenerate auto-selects newest and variant-toggle re-selects, both updating the live game', async ({ page }) => {
  await openAppAtRoom(page, 'ada');

  // 1. Author + generate one asset (replay produces a real image; gen1 selected).
  await page.getByTestId('asset-name').fill('Wild');
  await page.getByTestId('asset-prompt').fill('a glowing wild symbol');
  await page.getByTestId('asset-workflow').selectOption('schnell-transparent');
  await page.getByRole('button', { name: 'Add asset' }).click();
  await page.getByTestId('asset-generate').click();
  await expect(page.getByTestId('asset-selected-image')).toBeVisible({ timeout: 30_000 });

  // 2. Open the Game Scene pane; wait for engine handshake.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15000 });
  await expect.poll(() => page.evaluate(() => (window as any).__engineMsgs?.some((m: any) => m.kind === 'ready')), { timeout: 20000 }).toBe(true);

  const gameId = await page.evaluate(() => (window as any).__gameActiveId as string);
  expect(gameId).toBeTruthy();

  // 3. Read the asset id + gen1 image_ref from the backend wire.
  const { assetId, gen1Ref } = await page.evaluate(async (gid) => {
    const assets = await (await fetch(`/games/${gid}/assets`)).json();
    const a = assets[0];
    const sel = a.generations.find((g: any) => g.id === a.selectedGenerationId) ?? a.generations[0];
    return { assetId: a.id as string, gen1Ref: sel.imageRef as string };
  }, gameId);

  // 4. Place the asset into the scene on the BACKEND (Texture carries assetId), so
  //    server-side rebind can find it. Persist via the studio→backend socket path
  //    (__gameEmitApplyOp); the backend applies each op and broadcasts scene_op back
  //    to the room, which updates __gameSceneDocument and re-renders the engine.
  await page.evaluate(
    ({ gid, aid, ref }) => {
      const send = (window as any).__gameEmitApplyOp as (gid: string, op: unknown) => void;
      send(gid, { kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } });
      send(gid, { kind: 'addNode', id: 'spr.wild', type: 'Sprite' });
      send(gid, { kind: 'addNode', id: 'tex.wild', type: 'Texture', props: { src: ref, assetId: aid } });
      send(gid, { kind: 'connect', edgeId: 'e.child', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 'spr.wild', port: 'parent' } });
      send(gid, { kind: 'connect', edgeId: 'e.data', type: 'data', from: { node: 'tex.wild', port: 'data' }, to: { node: 'spr.wild', port: 'texture' } });
    },
    { gid: gameId, aid: assetId, ref: gen1Ref },
  );

  // baseline: the studio-synced document shows the bound texture at gen1
  await expect.poll(() => texSrc(page, 'tex.wild'), { timeout: 10000 }).toBe(gen1Ref);

  // 5. Regenerate on the board → auto-selects newest → backend rebinds → scene_op.
  await page.getByTestId('asset-generate').click();
  // the selected board image updates; the bound texture src flips to the new gen.
  const newRef = await expect
    .poll(
      async () => {
        const cur = await texSrc(page, 'tex.wild');
        return cur && cur !== gen1Ref ? cur : null;
      },
      { timeout: 30_000 },
    )
    .not.toBeNull()
    .then(() => texSrc(page, 'tex.wild'));
  expect(newRef).not.toBe(gen1Ref);

  // 6. Toggle back to the first variant via the candidate strip → game reverts.
  const firstThumb = page.getByTestId('asset-candidates').locator('img').first();
  await firstThumb.click();
  await expect.poll(() => texSrc(page, 'tex.wild')).toBe(gen1Ref);

  // 7. No engine errors throughout.
  expect(await page.evaluate(() => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length)).toBe(0);
});

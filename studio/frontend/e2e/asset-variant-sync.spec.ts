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

// Drives a chat run (generate_and_place) + two board generations + engine renders;
// allow for first-run Vite compile and the agent round-trip.
test.setTimeout(180_000);

test('regenerate auto-selects newest and variant-toggle re-selects, both updating the live game', async ({ page }) => {
  await openAppAtRoom(page, 'ada');

  // Use large view so the Generate action is always visible (not hover-gated in
  // medium/small) and the candidate strip is reliably present for the toggle below.
  await page.getByTestId('view-mode-large').click();

  // 1. Open the Game Scene pane FIRST and wait for the engine handshake, so the
  //    placement scene_op (step 2) is observed live as it arrives.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15000 });
  await expect.poll(() => page.evaluate(() => (window as any).__engineMsgs?.some((m: any) => m.kind === 'ready')), { timeout: 20000 }).toBe(true);

  const gameId = await page.evaluate(() => (window as any).__gameActiveId as string);
  expect(gameId).toBeTruthy();

  // 2. Place the wild symbol via CHAT → generate_and_place(slot=wild). The agent
  //    path is the only one that writes structural nodes to the BACKEND scene — the
  //    client socket (scene_apply_op) accepts setProp only (forbidden_kind otherwise).
  //    This creates the asset, generates gen1, and places spr.wild/tex.wild carrying
  //    props.assetId — exactly the bound-Texture precondition server-side rebind needs.
  const composer = page.getByTestId('chat-composer');
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill('add a glowing wild symbol');
  await page.getByTestId('chat-send').click();
  const feed = page.getByTestId('chat-messages');
  await expect(feed).toContainText('generate_and_place', { timeout: 60_000 });
  await expect(feed).toContainText('Added a glowing wild symbol', { timeout: 60_000 });

  // 3. Read the wild asset's gen1 image_ref from the backend wire.
  const gen1Ref = await page.evaluate(async (gid) => {
    const assets = await (await fetch(`/games/${gid}/assets`)).json();
    const a = assets.find((x: any) => x.slot === 'wild') ?? assets[0];
    const sel = a.generations.find((g: any) => g.id === a.selectedGenerationId) ?? a.generations[0];
    return sel.imageRef as string;
  }, gameId);
  expect(gen1Ref).toMatch(/^\/media\//);

  // baseline: the studio-synced document shows the bound texture at gen1
  await expect.poll(() => texSrc(page, 'tex.wild'), { timeout: 10000 }).toBe(gen1Ref);

  // Bring the Asset Board back to the front — opening the Game Preview stacked over
  // it in the same Dockview group (the preview stays mounted, so tex.wild updates
  // keep flowing). The board card for the agent-placed 'wild' asset lives here.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-assets/board').click();
  await expect(page.getByTestId('asset-generate')).toBeVisible({ timeout: 15_000 });

  // 4. Regenerate on the board → auto-selects newest → backend rebinds → scene_op.
  await page.getByTestId('asset-generate').click();
  // regenerate auto-selects the newest variant → bound texture src flips away from gen1
  await expect
    .poll(
      async () => {
        const cur = await texSrc(page, 'tex.wild');
        return cur && cur !== gen1Ref ? cur : null;
      },
      { timeout: 30_000 },
    )
    .not.toBeNull();

  // 5. Toggle back to the first variant via the candidate strip → game reverts.
  const firstThumb = page.getByTestId('asset-candidates').locator('img').first();
  await firstThumb.click();
  await expect.poll(() => texSrc(page, 'tex.wild'), { timeout: 15_000 }).toBe(gen1Ref);

  // 6. No engine errors throughout.
  expect(await page.evaluate(() => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length)).toBe(0);
});

import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage, BACKEND_URL } from './helpers';

// Browser e2e — authoritative behavioral contract for:
//   chat → design-router → set_gdd_fields + realize_symbol → scene Texture src changed
//   → engine iframe re-paints with a new sprite texture.
//
// Stack required (BLOOM_PORT_OFFSET=2):
//   backend (replay) :8002, engine :4302, studio :4202.
// Run: BLOOM_PORT_OFFSET=2 npx playwright test --config=studio/frontend/playwright.config.ts e2e/symbol-reshape.spec.ts
//
// Cassettes used (prompt-keyed, replay backend):
//   run/generate-sprite-high1.json  — prompt: "generate sprite for high1 slot"
//   run/seed-scene-high1.json       — prompt: "seed scene with high1 sprite and texture"
//   run/reshape-symbol.json         — prompt: "make the high symbol a dragon"
//
// Seeding approach:
//   - GDD row: REST PUT /games/:id/gdd/symbols-reels (from page.evaluate/fetch)
//   - Asset (high1): chat composer `/generate-sprite generate sprite for high1 slot` → Enter
//     (hasSpace+prose → runSkill path; cassette replays generate_asset with slot=high1)
//   - Scene: chat composer `/design-scene seed scene with high1 sprite and texture` → Enter
//     (hasSpace+prose → runSkill path; cassette replays scene_apply_batch with Sprite+Texture)
//   - Reshape: chat composer plain prose → Send button (routes through design-router)
//     (cassette: set_gdd_fields + realize_symbol → new generation + setProp scene_op)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function openAppAtRoom(page: Page, username: string): Promise<string> {
  // Install the engine-message recorder BEFORE navigation.
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
  await page.getByPlaceholder(/new room/i).fill(`SymbolReshape E2E ${Date.now()}`);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('workbench')).toBeVisible();
  return page.url();
}

/** Seed the symbols-reels GDD doc with a high1 row via the backend REST API. */
async function seedGddHigh1(page: Page, gameId: string): Promise<void> {
  const status = await page.evaluate(
    async ({ gid, backendUrl }: { gid: string; backendUrl: string }) => {
      const resp = await fetch(`${backendUrl}/games/${gid}/gdd/symbols-reels`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            symbols: [
              { slot: 'high1', name: 'Phoenix', kind: 'high', art_desc: 'a phoenix bird with red and gold feathers' },
            ],
          },
        }),
      });
      return resp.status;
    },
    { gid: gameId, backendUrl: BACKEND_URL },
  );
  expect(status).toBeLessThan(300);
}

/** Send text via the chat composer with Enter (handles slash commands and plain text). */
async function composerSend(page: Page, text: string, useButton = false): Promise<void> {
  const composer = page.getByTestId('chat-composer');
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill(text);
  if (useButton) {
    await page.getByTestId('chat-send').click();
  } else {
    await composer.press('Enter');
  }
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

// This test drives multiple skill runs and waits for an engine iframe render.
// Allow 5 minutes: first-run Vite compilation can take 30-120s alone.
test.setTimeout(300_000);

test('chat reshapes the high symbol and the rendered game re-paints', async ({ page }) => {
  // -----------------------------------------------------------------------
  // 1. Open app at a new room, capture room URL and game ID.
  // -----------------------------------------------------------------------
  await openAppAtRoom(page, 'ada');
  // Wait for both: the pane container AND the composer itself (rooms async-load).
  await expect(page.getByTestId('chat-room-pane')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 });

  // The game ID is set on window.__gameActiveId by game/actions.ts in dev mode.
  // Poll briefly — the game socket connects asynchronously after the room loads.
  await expect
    .poll(() => page.evaluate(() => (window as any).__gameActiveId ?? null), { timeout: 10_000 })
    .not.toBeNull();
  const gameId = await page.evaluate(() => (window as any).__gameActiveId as string | null);

  // -----------------------------------------------------------------------
  // 2. Seed GDD symbols-reels with a high1 row.
  // -----------------------------------------------------------------------
  await seedGddHigh1(page, gameId as string);

  // -----------------------------------------------------------------------
  // 3. Generate an initial asset for slot=high1.
  //    Cassette: generate-sprite-high1.json, keyed "generate sprite for high1 slot".
  //    The composer sends: run_skill("generate-sprite", {}, "generate sprite for high1 slot")
  //    which is keyed on the prose text, matching the cassette prompt.
  //    Final cassette output: "Generated a phoenix sprite for the high1 slot."
  // -----------------------------------------------------------------------
  await composerSend(page, '/generate-sprite generate sprite for high1 slot');
  const feed = page.getByTestId('chat-messages');
  await expect(feed).toContainText('Generated a phoenix sprite', { timeout: 30_000 });

  // Read back initial asset state (must have slot=high1 and ≥1 generation).
  const initialState = await page.evaluate(
    async ({ gid, backendUrl }: { gid: string; backendUrl: string }) => {
      const assets: any[] = await (await fetch(`${backendUrl}/games/${gid}/assets`)).json();
      const a = assets.find((x: any) => x.slot === 'high1') ?? null;
      if (!a) return null;
      const gens: any[] = a.generations ?? [];
      const sel = gens.find((g: any) => g.id === a.selectedGenerationId) ?? gens[gens.length - 1] ?? null;
      return { genCount: gens.length, imageRef: sel?.imageRef ?? null };
    },
    { gid: gameId as string, backendUrl: BACKEND_URL },
  );
  expect(initialState).not.toBeNull();
  expect((initialState as any).genCount).toBeGreaterThanOrEqual(1);
  const origGenCount: number = (initialState as any).genCount;
  const origImageRef: string = (initialState as any).imageRef;

  // -----------------------------------------------------------------------
  // 4. Seed the scene: Root+Container+Sprite(slot=high1)+Texture+edges.
  //    Cassette: seed-scene-high1.json, keyed "seed scene with high1 sprite and texture".
  //    Creates: sym.high1 (Sprite, props.slot=high1) + tex.high1 (Texture, src=/media/g/seed/old.png)
  //    Final cassette output: "Scene seeded with high1 sprite and texture."
  // -----------------------------------------------------------------------
  await composerSend(page, '/design-scene seed scene with high1 sprite and texture');
  await expect(feed).toContainText('Scene seeded with high1 sprite and texture', { timeout: 25_000 });

  // -----------------------------------------------------------------------
  // 5. Send the reshape prompt as plain prose via Send button (chat pane active).
  //    We send BEFORE opening the game scene pane so the chat pane remains
  //    active and the composer is accessible.
  //    Cassette: reshape-symbol.json, keyed "make the high symbol a dragon".
  //    Router: design-router → set_gdd_fields + realize_symbol.
  //    realize_symbol generates a new image → new generation on the asset
  //    → setProp scene_op on tex.high1 (src → new imageRef).
  //    Final cassette output: "Reshaped the high symbol → dragon."
  // -----------------------------------------------------------------------
  await composerSend(page, 'make the high symbol a dragon', true /* useButton */);
  await expect(feed).toContainText('Reshaped the high symbol', { timeout: 45_000 });

  // -----------------------------------------------------------------------
  // 6. Assert (a): the asset gained a new generation.
  // -----------------------------------------------------------------------
  const afterState = await page.evaluate(
    async ({ gid, backendUrl }: { gid: string; backendUrl: string }) => {
      const assets: any[] = await (await fetch(`${backendUrl}/games/${gid}/assets`)).json();
      const a = assets.find((x: any) => x.slot === 'high1') ?? null;
      if (!a) return null;
      const gens: any[] = a.generations ?? [];
      const sel = gens.find((g: any) => g.id === a.selectedGenerationId) ?? gens[gens.length - 1] ?? null;
      return { genCount: gens.length, imageRef: sel?.imageRef ?? null };
    },
    { gid: gameId as string, backendUrl: BACKEND_URL },
  );
  expect(afterState).not.toBeNull();
  const newGenCount: number = (afterState as any).genCount;
  expect(newGenCount).toBeGreaterThan(origGenCount);

  // -----------------------------------------------------------------------
  // 7. Assert (b): the selected/latest generation's imageRef changed.
  //    This proves realize_symbol wrote a new generation to the asset.
  // -----------------------------------------------------------------------
  const newImageRef: string = (afterState as any).imageRef;
  expect(newImageRef).toMatch(/^\/media\//);
  expect(newImageRef).not.toEqual(origImageRef);

  // -----------------------------------------------------------------------
  // 8. Open the Game Scene pane AFTER the reshape run completes.
  //    Wait for the engine handshake; the scene_op (setProp on tex.high1) was
  //    already applied by the backend before run_completed, so by the time the
  //    engine's 'ready' fires the socket client joins the scene and receives
  //    the up-to-date snapshot (with the new Texture src).
  // -----------------------------------------------------------------------
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-game/preview')).toBeVisible();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(
      () => page.evaluate(() => (window as any).__engineMsgs?.some((m: any) => m.kind === 'ready')),
      { timeout: 25_000 },
    )
    .toBe(true);

  // -----------------------------------------------------------------------
  // 9. Assert (c): rendered pixels show the new dragon sprite in the engine.
  //     After 'ready', the game socket client joins the scene and receives the
  //     current scene snapshot (with the new Texture src from realize_symbol).
  //     The engine initializes from that snapshot; the Sprite sym.high1 loads
  //     the new PNG from /media/... and textureSizeOf returns >0.
  // -----------------------------------------------------------------------
  const frameHandle = await page.getByTestId('game-engine-frame').elementHandle();
  const frame = await frameHandle!.contentFrame();
  expect(frame).not.toBeNull();

  await expect
    .poll(
      async () => frame!.evaluate(() => (window as any).__engineRenderer?.textureSizeOf('sym.high1')?.width ?? 0),
      { timeout: 25_000 },
    )
    .toBeGreaterThan(0);

  // -----------------------------------------------------------------------
  // 10. No engine errors during the session.
  // -----------------------------------------------------------------------
  expect(
    await page.evaluate(() => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length),
  ).toBe(0);
});

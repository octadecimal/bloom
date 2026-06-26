import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Browser e2e — authoritative behavioral contract for:
//   chat → design-router → generate_asset + add_sprite (×2) → engine iframe
//   renders a background sprite and a logo sprite with real textures.
//
// Stack required (replay backend): backend :8000+offset, engine, studio.
// Run: just backend-serve-replay  (then)  just e2e   — or target this file:
//   npx playwright test --config=studio/frontend/playwright.config.ts e2e/compose-scene.spec.ts
//
// Cassette (prompt-keyed, replay backend):
//   run/compose-pirate-scene.json
//     — prompt: "make a pirate theme game with a background and a logo centered at the top"
//     — generate_asset(slot=background) + add_sprite(slot=background, fit=cover)
//       generate_asset(slot=logo)       + add_sprite(slot=logo, y=0, anchor_y=0)
//
// Scene node ids (derived from the slots by add_sprite):
//   spr.background / tex.background, spr.logo / tex.logo, root (auto-created)

const PROMPT = 'make a pirate theme game with a background and a logo centered at the top';

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
  await page.getByPlaceholder(/new room/i).fill(`Compose E2E ${Date.now()}`);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('workbench')).toBeVisible();
}

// Drives one router run + an engine render; allow for first-run Vite compile.
test.setTimeout(300_000);

test('one chat prompt generates and places a background and logo, rendered live', async ({ page }) => {
  await openAppAtRoom(page, 'ada');
  await expect(page.getByTestId('chat-room-pane')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 });

  await expect.poll(() => page.evaluate(() => (window as any).__gameActiveId ?? null), { timeout: 10_000 }).not.toBeNull();
  const gameId = await page.evaluate(() => (window as any).__gameActiveId as string | null);
  expect(gameId).toBeTruthy();

  // 1. Send the pirate prompt as plain prose via the Send button (router path).
  const composer = page.getByTestId('chat-composer');
  await composer.fill(PROMPT);
  await page.getByTestId('chat-send').click();

  // 2. The feed shows the discrete tool calls (generate_asset + add_sprite) and the final line.
  const feed = page.getByTestId('chat-messages');
  await expect(feed).toContainText('generate_asset', { timeout: 60_000 });
  await expect(feed).toContainText('add_sprite', { timeout: 60_000 });
  await expect(feed).toContainText('Placed a pirate background and a logo', { timeout: 60_000 });

  // 3. Both assets exist with a generated image (backend wire).
  const slots = await page.evaluate(async (gid) => {
    const assets: any[] = await (await fetch(`/games/${gid}/assets`)).json();
    return assets.filter((a) => a.generations?.length).map((a) => a.slot);
  }, gameId);
  expect(slots).toContain('background');
  expect(slots).toContain('logo');

  // 4. Open the Game Scene pane and wait for the engine handshake.
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-game/preview')).toBeVisible();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__engineMsgs?.some((m: any) => m.kind === 'ready')), { timeout: 25_000 }).toBe(true);

  // 5. Both sprites render with real (>64px) textures inside the engine frame.
  const frameHandle = await page.getByTestId('game-engine-frame').elementHandle();
  const frame = await frameHandle!.contentFrame();
  expect(frame).not.toBeNull();
  for (const id of ['spr.background', 'spr.logo']) {
    await expect
      .poll(async () => frame!.evaluate((sid) => (window as any).__engineRenderer?.textureSizeOf(sid)?.width ?? 0, id), { timeout: 25_000 })
      .toBeGreaterThan(64);
  }

  // 6. No engine errors during the session.
  expect(await page.evaluate(() => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length)).toBe(0);
});

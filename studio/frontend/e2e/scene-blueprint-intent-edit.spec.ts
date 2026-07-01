import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Browser e2e — HITL Surface 2 contract (Scene Blueprint A2):
//   seed a background+logo scene -> open GDD viewer -> set focal_emphasis=logo -> Save
//   -> PUT triggers rebuild_scene server-side -> the logo reflows into its enlarged
//      planned region (its fit-scale increases) in the live engine.
//
// Stack (replay): backend :8000+offset, engine :4300+offset, studio :4200+offset.
// Run: just backend-serve-replay  (then)  target this file:
//   npx playwright test --config=studio/frontend/playwright.config.ts e2e/scene-blueprint-intent-edit.spec.ts
//
// Seed cassette (prompt-keyed): run/compose-pirate-scene.json (background + logo, same as
// compose-scene.spec.ts). The rebuild re-place pass's critic/asset verdicts fall through to
// the shipped defaults (critic done=true / asset keep), so no new cassettes are needed.

const SEED_PROMPT = 'make a pirate theme game with a background and a logo centered at the top';

// Create a room through the UI (RoomRoute -> openGameDocs(gameId) subscribes both the GDD
// viewer and the scene). Mirrors compose-scene.spec.ts, the proven engine-render path.
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
  await page.getByPlaceholder(/new room/i).fill(`Blueprint A2 ${Date.now()}`);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('workbench')).toBeVisible();
}

async function logoScale(page: Page): Promise<number> {
  const frameHandle = await page.getByTestId('game-engine-frame').elementHandle();
  const frame = await frameHandle!.contentFrame();
  return frame!.evaluate(() => (window as any).__engineRenderer?.scaleOf('spr.logo')?.x ?? 0);
}

// Drives one router run + an engine render + a rebuild; allow for first-run Vite compile.
test.setTimeout(300_000);

test('editing focal_emphasis in the GDD pane reflows the live scene', async ({ page }) => {
  await openAppAtRoom(page, 'ada');
  await expect(page.getByTestId('chat-room-pane')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 });

  // 1. Seed a scene (background + logo) via the compose cassette.
  await page.getByTestId('chat-composer').fill(SEED_PROMPT);
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-messages')).toContainText('Placed a pirate background and a logo', { timeout: 60_000 });

  // 2. Open the Game Scene pane; wait for the engine handshake, then for the logo to render.
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-game/preview')).toBeVisible();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__engineMsgs?.some((m: any) => m.kind === 'ready')), { timeout: 25_000 }).toBe(true);
  await expect.poll(() => logoScale(page), { timeout: 25_000 }).toBeGreaterThan(0);
  const before = await logoScale(page);

  // 3. Open the GDD viewer, select ui-ux, set focal_emphasis = logo, Save.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-gdd/viewer').click();
  await page.getByTestId('gdd-aspect-ui-ux').click();
  await page.getByTestId('gdd-intent-focal_emphasis').selectOption('logo');
  await page.getByTestId('gdd-intent-save').click();
  await expect(page.getByTestId('gdd-intent-status')).toContainText(/reflow/i, { timeout: 60_000 });

  // 4. Re-activate the Game Scene pane. Dockview unmounts the hidden engine tab (its
  //    bridge is cleared), so the live rebuild op only lands in the studio's scene store;
  //    re-activating remounts the pane and the engine re-inits from that reflowed doc.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15_000 });

  // 5. The logo reflowed into its enlarged planned region -> larger fit-scale.
  await expect.poll(() => logoScale(page), { timeout: 30_000 }).toBeGreaterThan(before);
});

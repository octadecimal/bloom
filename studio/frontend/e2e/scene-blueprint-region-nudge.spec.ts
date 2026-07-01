import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Browser e2e — HITL Surface 4 (Scene Blueprint A3): edit reels x in the Layout
// Regions editor -> Save -> the live engine reflows reels to x=200 -> the nudge
// survives a later approved rebuild (override is re-applied on top of the new plan).
// Stack (replay): backend :8000+offset, engine :4300+offset, studio :4200+offset.
// Run: just backend-serve-replay; npx playwright test e2e/scene-blueprint-region-nudge.spec.ts

const SEED_PROMPT = 'make a pirate theme game with a background and reels in the middle';

// Reads the reels sprite x position from the engine iframe.
// Returns -1 when the sprite is not yet placed (readiness guard for expect.poll).
async function reelsX(page: Page): Promise<number> {
  const frameHandle = await page.getByTestId('game-engine-frame').elementHandle();
  const frame = await frameHandle!.contentFrame();
  return frame!.evaluate(() => (window as any).__engineRenderer?.positionOf('spr.reels')?.x ?? -1);
}

// Allow time for: Vite compile, room create round-trip, design-router LLM run,
// engine handshake + render, region PUT + reflow, approval gate on rebuild.
test.setTimeout(300_000);

test('nudging reels x in the region editor reflows the live scene and survives rebuild', async ({ page }) => {
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username: 'ada' } }));
  await page.goto('/');
  await page.getByPlaceholder(/new room/i).fill(`Blueprint A3 nudge ${Date.now()}`);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('workbench')).toBeVisible();
  await expect(page.getByTestId('chat-room-pane')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 });

  // 1. Seed a scene with reels via the compose cassette.
  await page.getByTestId('chat-composer').fill(SEED_PROMPT);
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-messages')).toContainText(/reels/i, { timeout: 60_000 });

  // 2. Open the Game Scene pane first; wait for the engine to render reels.
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-game/preview')).toBeVisible();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => reelsX(page), { timeout: 25_000 }).toBeGreaterThanOrEqual(0);

  // 3. Open the Layout Regions pane alongside the Game Scene pane.
  //    Note: Dockview may hide the engine tab when a second pane opens; if so, reelsX
  //    polling after Save will need a re-activate step (addressed when making the spec
  //    green, see brief Task 12 Step 2).
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-region-overrides/preview')).toBeVisible();
  await page.getByTestId('view-open-region-overrides/preview').click();
  await expect(page.getByTestId('region-editor')).toBeVisible({ timeout: 15_000 });

  // 4. Nudge reels x to 200 and Save.
  //    Testids: region-{role}-{field} and region-{role}-save where role='reels'.
  await page.getByTestId('region-reels-x').fill('200');
  await page.getByTestId('region-reels-save').click();
  // Status text is "Reflowed reels." when the PUT triggers a re-place (rebuilt=true).
  await expect(page.getByTestId('region-status')).toContainText(/reflow/i, { timeout: 60_000 });
  await expect.poll(() => reelsX(page), { timeout: 30_000 }).toBe(200);

  // 5. Survive a rebuild: a chat intent edit triggers rebuild_scene -> approve -> the
  //    override is re-applied on top of the new plan so reels stays at x=200.
  await page.getByTestId('chat-composer').fill('make the framing ornate');
  await page.getByTestId('chat-send').click();
  // Wait explicitly for the approval card (same design-router → rebuild_scene path as
  // the approval-gate spec) before clicking Approve.
  await expect(page.getByTestId('approval-card')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('approval-card').getByRole('button', { name: /approve/i }).click();
  // Override must survive the rebuild: reels should still be at x=200.
  await expect.poll(() => reelsX(page), { timeout: 30_000 }).toBe(200);
});

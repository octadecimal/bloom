import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Browser e2e — HITL Surface 3 (Scene Blueprint A3): a chat intent edit makes the
// agent call rebuild_scene -> an ApprovalCard appears -> Approve reflows / Deny leaves
// the scene unchanged. Stack (replay): backend :8000+offset, engine :4300+offset,
// studio :4200+offset (set BLOOM_PORT_OFFSET in env before running).
// Run: just backend-serve-replay; npx playwright test e2e/scene-blueprint-approval-gate.spec.ts

const SEED_PROMPT = 'make a pirate theme game with a background and a logo centered at the top';
const EDIT_PROMPT = 'make the framing ornate';

async function openAppAtRoom(page: Page, username: string): Promise<void> {
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await page.getByPlaceholder(/new room/i).fill(`Blueprint A3 gate ${Date.now()}`);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('workbench')).toBeVisible();
}

// Reads the logo's y position out of the engine iframe.
// Returns -1 when the sprite is not yet placed (used by expect.poll readiness guard).
async function logoPos(page: Page): Promise<number> {
  const frameHandle = await page.getByTestId('game-engine-frame').elementHandle();
  const frame = await frameHandle!.contentFrame();
  return frame!.evaluate(() => (window as any).__engineRenderer?.positionOf('spr.logo')?.y ?? -1);
}

// Allow time for: Vite compile, room create round-trip, design-router LLM run (2 turns),
// engine handshake + render, approval gate display.
test.setTimeout(300_000);

test('rebuild_scene pauses on an approval card; approve reflows the scene', async ({ page }) => {
  await openAppAtRoom(page, 'ada');
  await expect(page.getByTestId('chat-room-pane')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 });

  // 1. Seed a scene (background + logo) via the compose cassette.
  await page.getByTestId('chat-composer').fill(SEED_PROMPT);
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-messages')).toContainText(/background and a logo/i, { timeout: 60_000 });

  // 2. Open the Game Scene pane; wait for the logo to render in the engine.
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-game/preview')).toBeVisible();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => logoPos(page), { timeout: 25_000 }).toBeGreaterThanOrEqual(0);
  const before = await logoPos(page);

  // 3. Ask the agent to change intent -> it calls rebuild_scene -> approval card appears.
  await page.getByTestId('chat-composer').fill(EDIT_PROMPT);
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('approval-card')).toBeVisible({ timeout: 60_000 });

  // 4. Approve -> the scene reflows (the logo moves to its newly planned region).
  await page.getByTestId('approval-card').getByRole('button', { name: /approve/i }).click();
  await expect.poll(() => logoPos(page), { timeout: 30_000 }).not.toBe(before);
});

test('rebuild_scene pauses on an approval card; deny leaves the scene unchanged', async ({ page }) => {
  await openAppAtRoom(page, 'ada');
  await expect(page.getByTestId('chat-room-pane')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 });

  // 1. Seed a scene (background + logo) via the compose cassette.
  await page.getByTestId('chat-composer').fill(SEED_PROMPT);
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-messages')).toContainText(/background and a logo/i, { timeout: 60_000 });

  // 2. Open the Game Scene pane; wait for the logo to render.
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-game/preview')).toBeVisible();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => logoPos(page), { timeout: 25_000 }).toBeGreaterThanOrEqual(0);
  const before = await logoPos(page);

  // 3. Ask the agent to change intent -> approval card appears.
  await page.getByTestId('chat-composer').fill(EDIT_PROMPT);
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('approval-card')).toBeVisible({ timeout: 60_000 });

  // 4. Deny -> the re-place pass is never triggered; logo stays at its original position.
  await page.getByTestId('approval-card').getByRole('button', { name: /deny/i }).click();
  // Short settle; value should remain `before` because no rebuild ran.
  await expect.poll(() => logoPos(page), { timeout: 10_000 }).toBe(before);
});

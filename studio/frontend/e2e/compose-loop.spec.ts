import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Local-only (browser e2e is never in CI). Requires the full stack at this
// worktree's BLOOM_PORT_OFFSET: engine (runtime client), replay backend, studio.
// Proves the compose-loop orchestrator end-to-end in a real browser: one build
// prompt routes design-router branch 4 -> compose_scene, which places each
// element and (with the replay critic) nudges placement; the Game Scene pane
// reflows live and the chat feed shows the compose_scene step.

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
  await page.getByPlaceholder(/new room/i).fill(`Compose Loop E2E ${Date.now()}`);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('workbench')).toBeVisible();
}

test.setTimeout(300_000);

test('one build prompt composes a scene through the critic loop, rendered live', async ({ page }) => {
  await openAppAtRoom(page, 'ada');

  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__gameActiveId ?? null), { timeout: 10_000 }).not.toBeNull();

  // Open the Game Scene pane first so the engine is attached and answers the
  // orchestrator's capture requests during the build.
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-game/preview')).toBeVisible();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__engineMsgs?.some((m: any) => m.kind === 'ready')), { timeout: 25_000 }).toBe(true);

  // Send the build prompt.
  await page.getByTestId('chat-composer').fill(PROMPT);
  await page.getByTestId('chat-send').click();

  // The chat feed shows the compose_scene orchestrator step and the final reply.
  const feed = page.getByTestId('chat-messages');
  await expect(feed).toContainText('compose_scene', { timeout: 90_000 });
  await expect(feed).toContainText('Placed a pirate background and a logo', { timeout: 90_000 });

  // Both sprites render with real textures (the scene composed).
  const frameHandle = await page.getByTestId('game-engine-frame').elementHandle();
  const frame = await frameHandle!.contentFrame();
  for (const id of ['spr.background', 'spr.logo']) {
    await expect
      .poll(async () => frame!.evaluate((sid) => (window as any).__engineRenderer?.textureSizeOf(sid)?.width ?? 0, id), { timeout: 25_000 })
      .toBeGreaterThan(64);
  }

  // No engine errors during the composed build.
  expect(await page.evaluate(() => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length)).toBe(0);
});

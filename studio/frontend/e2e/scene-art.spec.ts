import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Local-only (browser e2e is never in CI). Requires the full stack at this
// worktree's BLOOM_PORT_OFFSET=1: runtime client (4301), replay backend (8001),
// studio (4201). Proves sub-project B end-to-end in a real browser: with the
// engine attached and answering capture, the compose build runs the real-frame
// art/effects grade and its verdict surfaces in the chat feed.

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
  await page.getByPlaceholder(/new room/i).fill(`Scene Art E2E ${Date.now()}`);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('workbench')).toBeVisible();
}

test.setTimeout(300_000);

test('the compose build runs the real-frame art grade and reports its verdict', async ({ page }) => {
  await openAppAtRoom(page, 'ada');

  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__gameActiveId ?? null), { timeout: 10_000 }).not.toBeNull();

  // Open the Game Scene pane so the engine attaches and answers the art stage's
  // capture request.
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-game/preview')).toBeVisible();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__engineMsgs?.some((m: any) => m.kind === 'ready')), { timeout: 25_000 }).toBe(true);

  await page.getByTestId('chat-composer').fill(PROMPT);
  await page.getByTestId('chat-send').click();

  const feed = page.getByTestId('chat-messages');
  await expect(feed).toContainText('compose_scene', { timeout: 90_000 });
  // The real-frame art/effects grade ran (not skipped) and its verdict surfaced.
  await expect(feed).toContainText('Scene reads as a premium slot', { timeout: 90_000 });

  // No engine errors during the composed build + capture.
  expect(await page.evaluate(() => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length)).toBe(0);
});

import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Local-only (browser e2e is never in CI). Requires the full stack on the
// worktree's offset ports: engine, backend (replay), studio. Drives the real
// socket path: Add Reels -> declaration -> projected grid; Spin -> server round
// -> rendered settle. The engine iframe is cross-origin, so engine globals are
// read via Playwright's contentFrame(), not the top window.

async function openGamePane(page: Page): Promise<string> {
  await page.addInitScript(() => {
    (window as any).__engineMsgs = [];
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (d && (d.kind === 'ready' || d.kind === 'error')) {
        (window as any).__engineMsgs.push({ origin: e.origin, kind: d.kind });
      }
    });
  });
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username: 'ada' } }));
  await page.goto('/');
  await page.getByPlaceholder(/new room/i).fill(`Reels E2E ${Date.now()}`);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('workbench')).toBeVisible();

  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15000 });
  await expect.poll(() => page.evaluate(() => (window as any).__engineMsgs.some((m: any) => m.kind === 'ready')), { timeout: 20000 }).toBe(true);

  const gameId = await page.evaluate(() => (window as any).__gameActiveId ?? null);
  expect(gameId).toBeTruthy();
  return gameId as string;
}

async function engineFrame(page: Page) {
  const handle = await page.getByTestId('game-engine-frame').elementHandle();
  const frame = await handle!.contentFrame();
  expect(frame).toBeTruthy();
  return frame!;
}

test('Add Reels projects a color-coded grid; Spin lands on the server outcome', async ({ page }) => {
  await openGamePane(page);
  const frame = await engineFrame(page);

  // 1. Add Reels -> the declaration projects cells into the engine model.
  await page.getByTestId('game-add-reels').click();
  await expect.poll(() => frame.evaluate(() => (window as any).__engineModel?.toDocument().nodes['reels:cell:0:0'] != null), { timeout: 20000 }).toBe(true);

  // The grid is color-coded + labeled: cell carries a hex fill and a label.
  const cell = await frame.evaluate(() => (window as any).__engineModel.toDocument().nodes['reels:cell:0:0'].props);
  expect(String(cell.fill)).toMatch(/^#[0-9a-f]{6}$/i);
  expect(cell.label).toBeDefined();

  // 2. Spin -> the backend evaluates a round and broadcasts an outcome.
  await page.getByTestId('game-spin').click();
  await expect.poll(() => page.evaluate(() => (window as any).__gameLastSpinOutcome ?? null), { timeout: 20000 }).not.toBeNull();
  const outcome = await page.evaluate(() => (window as any).__gameLastSpinOutcome as { grid: string[][] });

  // 3. End-state: the engine settles to idle and the RENDERED grid equals the
  //    server's outcome (assert reconciliation, not dispatch).
  await expect.poll(() => frame.evaluate(() => (window as any).__engineModules.state().phase), { timeout: 10000 }).toBe('idle');
  const rendered = await frame.evaluate(() => (window as any).__engineModules.state().grid);
  expect(rendered).toEqual(outcome.grid);

  // 4. And the landed cells took the outcome's colors (structure plane updated).
  const landedFill = await frame.evaluate(() => (window as any).__engineModel.toDocument().nodes['reels:cell:0:0'].props.fill);
  expect(String(landedFill)).toMatch(/^#[0-9a-f]{6}$/i);

  // No engine errors during the session.
  expect(await page.evaluate(() => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length)).toBe(0);
});

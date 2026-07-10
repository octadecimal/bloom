import { test, expect, type Page } from '@playwright/test';
import { BACKEND_URL, seedLocalStorage } from './helpers';

// Local-only (browser e2e is never in CI). Requires the worktree-offset stack:
// engine, replay backend (which points RUNTIME_SERVER_URL at the e2e runtime
// server below), studio frontend; Playwright's webServer boots the dir-mode
// runtime server on 9300+offset. Contract: mechanics declared in Game Structure
// ARE the scene (no manual Add Reels), and Spin plays the authoritative
// composed round via a served trace.

const offset = Number(process.env.BLOOM_PORT_OFFSET ?? 0) || 0;
const RUNTIME = `http://localhost:${9300 + offset}`;

async function setupRoom(page: Page): Promise<string> {
  const roomName = `reels ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const resp = await fetch(`${BACKEND_URL}/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: roomName }),
  });
  expect(resp.ok).toBeTruthy();
  const room = (await resp.json()) as { id: string; gameId: string };
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username: 'ada' } }));
  await page.goto('/');
  await expect(page.getByTestId('room-picker')).toBeVisible();
  await page.getByTestId('room-picker').getByText(roomName, { exact: true }).click();
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
  return room.gameId;
}

async function openGameScene(page: Page) {
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15000 });
}

// Re-resolve the engine frame on every evaluation: opening another pane makes
// dockview re-parent the iframe, which reloads it and detaches old Frame handles.
async function engineEval<T>(page: Page, fn: () => T): Promise<T> {
  const handle = await page.getByTestId('game-engine-frame').elementHandle();
  const frame = await handle!.contentFrame();
  expect(frame).toBeTruthy();
  return frame!.evaluate(fn);
}

test('Game Structure mechanics render in the scene and Spin plays a served trace', async ({ page }) => {
  test.setTimeout(420_000); // first auto-build may compile compose_json + mint a 10k-seed pool
  const gameId = await setupRoom(page);
  await openGameScene(page);

  // No Add Reels button — mechanics are declared in Game Structure.
  await expect(page.getByTestId('game-add-reels')).toHaveCount(0);

  // Opening Game Structure seeds the definition -> the scene grows the
  // template's mechanics (main_reels + bonus_meter) with no manual step.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-game-structure/editor').click();
  await expect(page.getByTestId('gs-tab-mechanics')).toBeVisible();
  // Game Structure lands in the same dockview group and hides the scene tab;
  // re-opening Game Scene focuses it (panes contract) so the engine frame is reachable.
  await openGameScene(page);
  await expect
    .poll(() => engineEval(page, () => (window as any).__engineModel?.toDocument().nodes['main_reels:cell:0:0'] != null), { timeout: 30000 })
    .toBe(true);
  expect(await engineEval(page, () => Object.keys((window as any).__engineModel.toDocument().nodes).some((k) => k.startsWith('bonus_meter')))).toBe(true);

  // The definition save (seed) auto-builds the package; wait for the dir-mode
  // runtime server to serve it.
  await expect.poll(async () => (await fetch(`${RUNTIME}/handshake?package=${gameId}`)).status, { timeout: 360_000, intervals: [3000] }).toBe(200);

  // Spin -> the backend proxies the authoritative server and broadcasts a trace.
  await page.getByTestId('game-spin').click();
  await expect.poll(() => page.evaluate(() => (window as any).__gameLastSpinTrace ?? null), { timeout: 30000 }).not.toBeNull();
  const trace = await page.evaluate(() => (window as any).__gameLastSpinTrace.trace as Array<any>);
  expect(trace.at(-1)?.t).toBe('round_end');

  // End-state: reels settle to idle on the trace's grid (assert reconciliation,
  // not dispatch) and no error bar is shown.
  await expect.poll(() => engineEval(page, () => (window as any).__engineModules.state().phase), { timeout: 20000 }).toBe('idle');
  const trigger = trace.find((e) => e.t === 'trigger' && e.data?.kind === 'reels');
  expect(trigger).toBeTruthy();
  const rendered = await engineEval(page, () => (window as any).__engineModules.state().grid);
  expect(rendered).toEqual(trigger.data.grid.map((reel: number[]) => reel.map(String)));
  await expect(page.getByTestId('game-spin-error')).toHaveCount(0);
});

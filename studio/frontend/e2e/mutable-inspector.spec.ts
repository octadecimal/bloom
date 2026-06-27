import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Local-only (browser e2e is never in CI). Requires the full stack on the
// worktree offset: engine :4301, backend :8001 (replay), studio :4201.
//
// Proves the Inspector's UI→wire contract: editing a scalar emits the right
// scene_apply_op (captured via window.__gameLastApplyOp). The backend
// round-trip + persistence is covered by the pytest e2e (test_scene_mutate.py).

async function openRoom(page: Page): Promise<void> {
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username: 'ada' } }));
  await page.goto('/');
  await page.getByPlaceholder(/new room/i).fill(`Inspector E2E ${Date.now()}`);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('workbench')).toBeVisible();
}

test('editing a scalar in the Inspector emits a setProp scene_apply_op', async ({ page }) => {
  await openRoom(page);

  // Open the Game Scene pane so activeGameId is set and the socket joins.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15000 });
  const gameId = await page.evaluate(() => (window as any).__gameActiveId as string | null);
  expect(gameId).toBeTruthy();

  // Seed a local node into the mirror (scene-graph reads the same store).
  await page.evaluate((gid) => {
    const apply = (window as any).__gameApplyInbound as (e: string, p: unknown) => void;
    apply('scene_op', { gameId: gid, op: { kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } } });
    apply('scene_op', { gameId: gid, op: { kind: 'addNode', id: 's1', type: 'Sprite', props: { x: 120, visible: true } } });
  }, gameId);

  // Open Scene Graph + Inspector panes.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-scene-graph/tree').click();
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-property-inspector/panel').click();

  // Select the sprite; the Inspector shows its props.
  await page.getByTestId('scene-row-s1').click();
  const xInput = page.getByTestId('inspector-edit-x');
  await expect(xInput).toHaveValue('120');

  // Edit the number; assert the emitted op (debounced ~80ms).
  await xInput.fill('175');
  await expect
    .poll(() => page.evaluate(() => (window as any).__gameLastApplyOp ?? null), { timeout: 5000 })
    .toMatchObject({ gameId, op: { kind: 'setProp', id: 's1', path: 'x', value: 175 } });

  // Esc reverts the field to the store value.
  await xInput.focus();
  await xInput.fill('999');
  await xInput.press('Escape');
  await expect(xInput).toHaveValue('120');
});

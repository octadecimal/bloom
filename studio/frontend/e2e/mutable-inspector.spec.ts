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

  // Wait for the definition->scene sync snapshot (it always contains a Root —
  // ensure_root runs before set_modules broadcasts it). Seeding before it lands
  // would be wiped: scene_snapshot wholesale-replaces the client document.
  await expect
    .poll(
      () => page.evaluate(() => Object.values(((window as any).__gameSceneSnapshot?.document?.nodes ?? {}) as Record<string, any>).some((n: any) => n?.type === 'Root')),
      { timeout: 15000 },
    )
    .toBe(true);

  // Seed a local node into the mirror (scene-graph reads the same store). The
  // sprite MUST be parented under Root via a `child` edge — the scene-graph tree
  // only shows nodes reachable from Root (buildTree), so an orphan sprite would
  // never render a `scene-row-*` to select.
  await page.evaluate((gid) => {
    const apply = (window as any).__gameApplyInbound as (e: string, p: unknown) => void;
    apply('scene_op', { gameId: gid, op: { kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } } });
    apply('scene_op', { gameId: gid, op: { kind: 'addNode', id: 's1', type: 'Sprite', props: { x: 120, visible: true } } });
    apply('scene_op', {
      gameId: gid,
      op: { kind: 'connect', edgeId: 'e.child', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 's1', port: 'parent' } },
    });
  }, gameId);

  // Open the Scene Graph pane and select the sprite FIRST — selection lives in
  // shared state (sceneGraphSlice.selectedId), so it survives opening the
  // Inspector next. (Opening the Inspector last would stack it on top of the
  // Scene Graph in the same Dockview group, hiding the rows we need to click.)
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-scene-graph/tree').click();
  await expect(page.getByTestId('scene-row-s1')).toBeVisible({ timeout: 10000 });
  await page.getByTestId('scene-row-s1').click();

  // Now open the Inspector; it reads the selection from state and shows props.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-property-inspector/panel').click();
  const xInput = page.getByTestId('inspector-edit-x');
  await expect(xInput).toHaveValue('120');

  // Edit the number; with no debounce the op fires immediately on change.
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

test('typing a multi-digit value emits one scene_apply_op per change', async ({ page }) => {
  await openRoom(page);

  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15000 });
  const gameId = await page.evaluate(() => (window as any).__gameActiveId as string | null);
  expect(gameId).toBeTruthy();

  // Wait for the definition->scene sync snapshot (it always contains a Root —
  // ensure_root runs before set_modules broadcasts it). Seeding before it lands
  // would be wiped: scene_snapshot wholesale-replaces the client document.
  await expect
    .poll(
      () => page.evaluate(() => Object.values(((window as any).__gameSceneSnapshot?.document?.nodes ?? {}) as Record<string, any>).some((n: any) => n?.type === 'Root')),
      { timeout: 15000 },
    )
    .toBe(true);

  await page.evaluate((gid) => {
    const apply = (window as any).__gameApplyInbound as (e: string, p: unknown) => void;
    apply('scene_op', { gameId: gid, op: { kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } } });
    apply('scene_op', { gameId: gid, op: { kind: 'addNode', id: 's1', type: 'Sprite', props: { x: 5, visible: true } } });
    apply('scene_op', {
      gameId: gid,
      op: { kind: 'connect', edgeId: 'e.child', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 's1', port: 'parent' } },
    });
  }, gameId);

  // Record EVERY emitted op (not just the last) by trapping assignments.
  await page.evaluate(() => {
    const w = window as any;
    w.__opLog = [];
    let last: unknown;
    Object.defineProperty(w, '__gameLastApplyOp', {
      configurable: true,
      get: () => last,
      set: (v) => {
        last = v;
        w.__opLog.push(v);
      },
    });
  });

  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-scene-graph/tree').click();
  await expect(page.getByTestId('scene-row-s1')).toBeVisible({ timeout: 10000 });
  await page.getByTestId('scene-row-s1').click();

  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-property-inspector/panel').click();
  const xInput = page.getByTestId('inspector-edit-x');
  await expect(xInput).toHaveValue('5');

  // One change at a time, waiting for each op (and its server echo) to settle
  // before the next — the echo re-renders the controlled input, and racing it
  // with queued keystrokes stomps the draft on a slow backend. Three parsed
  // changes → three ops, no debounce: the same contract as before.
  const opValues = () =>
    page.evaluate(() => ((window as any).__opLog ?? []).filter((o: any) => o?.op?.id === 's1' && o?.op?.path === 'x').map((o: any) => o.op.value));
  await xInput.fill('1');
  await expect.poll(opValues, { timeout: 5000 }).toEqual([1]);
  await xInput.fill('10');
  await expect.poll(opValues, { timeout: 5000 }).toEqual([1, 10]);
  await xInput.fill('100');
  await expect.poll(opValues, { timeout: 5000 }).toEqual([1, 10, 100]);
});

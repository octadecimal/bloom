import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Browser e2e — authoritative contract for the FULL Property Inspector write
// round-trip through the REAL frontend socket:
//
//   edit a scalar in the Inspector UI
//     → frontend emits scene_apply_op on the live game socket
//       → backend GameSceneHub.apply_op persists + broadcasts scene_op
//         → the echo updates the studio scene store + the field reconciles
//
// This is deliberately stronger than mutable-inspector.spec.ts, which seeded
// nodes LOCALLY (window.__gameApplyInbound, never persisted) and only asserted
// the op was emitted. That test was blind to a broken round-trip — e.g. a
// backend with no scene_apply_op handler silently drops the op, the field
// reverts on blur, and the game never moves. Here we use a REAL backend-
// persisted scene and assert the value is actually PERSISTED (read back from a
// fresh snapshot) and that the field reconciles to it — both fail if the
// round-trip is broken.
//
// Stack required (replay backend): backend :8000+offset, engine, studio.
// Run: just backend-serve-replay  (then)  just e2e   — or target this file:
//   npx playwright test --config=studio/frontend/playwright.config.ts e2e/inspector-mutation-roundtrip.spec.ts
//
// Cassette (prompt-keyed, replay): run/compose-pirate-scene.json — produces real
// persisted scene nodes spr.background / spr.logo / root (same as compose-scene.spec.ts).

const PROMPT = 'make a pirate theme game with a background and a logo centered at the top';
const SELECTED_ID = 'spr.logo'; // placed with numeric props (y, anchor_y) by generate_and_place

async function openAppAtRoom(page: Page, username: string): Promise<void> {
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await page.getByPlaceholder(/new room/i).fill(`Inspector Roundtrip ${Date.now()}`);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('workbench')).toBeVisible();
}

// Read a dotted path (e.g. "position.x") out of a node's props in the latest snapshot.
function readPersisted(page: Page, nodeId: string, path: string): Promise<number | string | boolean | null> {
  return page.evaluate(
    ({ nodeId, path }) => {
      const snap = (window as any).__gameSceneSnapshot as { document: { nodes: Record<string, { props: any }> } } | undefined;
      if (!snap) return null;
      let v: any = snap.document.nodes[nodeId]?.props;
      for (const k of path.split('.')) {
        if (v == null) return null;
        v = v[k];
      }
      return v ?? null;
    },
    { nodeId, path },
  );
}

// Force the backend to resend a fresh snapshot (the authoritative persisted doc),
// then let it arrive before the caller reads it.
async function refreshSnapshot(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).__gameSceneSnapshot = undefined;
    const join = (window as any).__gameJoinScene as ((g: string) => void) | undefined;
    const gid = (window as any).__gameActiveId as string | null;
    if (join && gid) join(gid);
  });
  await page.waitForTimeout(800); // let the fresh scene_snapshot round-trip back
}

test.setTimeout(300_000); // first-run Vite compile + a replay generation round.

test('editing a scalar persists through the real socket round-trip and the field reconciles', async ({ page }) => {
  await openAppAtRoom(page, 'ada');
  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__gameActiveId ?? null), { timeout: 10_000 }).not.toBeNull();
  const gameId = (await page.evaluate(() => (window as any).__gameActiveId as string)) as string;

  // 1. Build a REAL, backend-persisted scene from the deterministic cassette.
  await page.getByTestId('chat-composer').fill(PROMPT);
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-messages')).toContainText('Placed a pirate background and a logo', { timeout: 120_000 });

  // 2. Open the Scene Graph and select the logo sprite (a real persisted node).
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-scene-graph/tree').click();
  await expect(page.getByTestId(`scene-row-${SELECTED_ID}`)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`scene-row-${SELECTED_ID}`).click();

  // 3. Open the Inspector and discover a numeric scalar leaf to edit (don't hardcode
  //    the realized prop shape — find the first number input the Inspector renders).
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-property-inspector/panel').click();
  const edits = page.locator('[data-testid^="inspector-edit-"]');
  await expect(edits.first()).toBeVisible({ timeout: 15_000 });

  let path: string | null = null;
  let current: number | null = null;
  const count = await edits.count();
  for (let i = 0; i < count; i++) {
    const el = edits.nth(i);
    if ((await el.getAttribute('type')) !== 'number') continue;
    const tid = await el.getAttribute('data-testid');
    const raw = await el.inputValue();
    if (tid && raw.trim() !== '' && Number.isFinite(Number(raw))) {
      path = tid.replace('inspector-edit-', '');
      current = Number(raw);
      break;
    }
  }
  expect(path, 'expected a numeric scalar leaf on the selected sprite').not.toBeNull();
  const newValue = (current as number) + 137; // distinctive delta
  const field = page.getByTestId(`inspector-edit-${path}`);

  // 4. Establish the persisted baseline BEFORE the edit (proves the value really changes).
  await refreshSnapshot(page);
  expect(await readPersisted(page, SELECTED_ID, path as string)).toBe(current);

  // 5. Edit the value in the real UI and commit with Enter.
  await field.fill(String(newValue));
  await field.press('Enter');

  // 6. THE round-trip proof: the field reconciles to the echoed value and does NOT
  //    revert. This only happens after emit → backend apply_op → broadcast → the
  //    scene_op echo updates the store → the widget re-renders from the new `raw`.
  //    A broken round-trip (e.g. a backend with no scene_apply_op handler) leaves
  //    the field reverted to the old value on blur, so this times out.
  await expect(field).toHaveValue(String(newValue), { timeout: 15_000 });

  // 7. Persistence proof: the scene_op echo is broadcast only AFTER the backend
  //    persists, so by now the new value is durable. Confirm it from a fresh
  //    authoritative snapshot (re-fetched, not the cached one).
  await refreshSnapshot(page);
  expect(await readPersisted(page, SELECTED_ID, path as string)).toBe(newValue);

  // 8. Esc is undo: typing a new value commits it live, then Escape re-commits
  //    the focus-time value (newValue) — the field AND the persisted snapshot
  //    both revert, proving the undo round-tripped through the backend.
  await field.click(); // focus so originalOnFocus captures the committed newValue
  await field.fill(String(newValue + 999));
  await field.press('Escape');
  await expect(field).toHaveValue(String(newValue));
  await refreshSnapshot(page);
  expect(await readPersisted(page, SELECTED_ID, path as string)).toBe(newValue);
});

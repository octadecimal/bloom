import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { seedLocalStorage, BACKEND_URL as BACKEND } from './helpers';

// Drives the full GDD/SlotModel ownership loop (spec 2026-07-09) against a real
// backend + frontend: a shape edit on an untouched model realizes silently, the
// GDD viewer mirrors the realized paytable, a human edit "touches" the model so
// the next shape edit goes pending + flags shape-stale everywhere it surfaces
// (GDD banner, Game Config pill), and the explicit re-realize affordance clears
// it. Test 2 covers the sibling staleness axis — a target-field edit after a
// stored verdict flags the Math pane's STALE chip.
//
// Stack (replay backend, BLOOM_PORT_OFFSET aware): backend :8000+offset,
// frontend :4200+offset. Run: just backend-serve-replay (then) just e2e, or
// target this file: npx playwright test e2e/gdd-ownership.spec.ts

/** Create a room via the API (auto-creates a game); returns its id + gameId. Does
 * NOT navigate — callers seed GDD/slot-model state via REST first (the GDD
 * viewer's doc list is fetched once at room-open time and only merges later
 * per-aspect PUTs incrementally via socket, so anything seeded silently by
 * seed_taxonomy — e.g. the paytable/bonus-features taxonomy entries — before
 * that initial fetch would otherwise never reach the client). */
async function createGameRoom(request: APIRequestContext, roomName: string): Promise<{ id: string; gameId: string }> {
  const resp = await request.post(`${BACKEND}/rooms`, { data: { name: roomName } });
  expect(resp.ok()).toBeTruthy();
  return (await resp.json()) as { id: string; gameId: string };
}

/** Log in and navigate into an already-created room. */
async function enterRoom(page: Page, username: string, roomName: string): Promise<void> {
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await expect(page.getByTestId('room-picker')).toBeVisible();
  await page.getByTestId('room-picker').getByText(roomName, { exact: true }).click();
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
}

/** Open a pane via the View menu, waiting for a testid it renders once loaded. */
async function openPane(page: Page, paneId: string, paneTestId: string) {
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId(`view-open-${paneId}`)).toBeVisible();
  await page.getByTestId(`view-open-${paneId}`).click();
  await expect(page.getByTestId(paneTestId)).toBeVisible({ timeout: 10_000 });
}

async function getSlotModelDoc(request: APIRequestContext, gameId: string) {
  const resp = await request.get(`${BACKEND}/games/${gameId}/slot-model`);
  expect(resp.ok()).toBeTruthy();
  return (await resp.json()) as { model: { reels: unknown[] }; shapeStale: boolean; verdictStale: boolean };
}

test('shape edit realizes the model, mirrors it, and staleness round-trips', async ({ page, request }) => {
  const roomName = `gdd-own ${Date.now()}`;
  const { gameId } = await createGameRoom(request, roomName);

  // 1. Seed a realizable design via REST (symbols + dims). Untouched model: the
  //    shape edit below realizes silently ("applied"), no human PUT has happened yet.
  await request.put(`${BACKEND}/games/${gameId}/gdd/symbols-reels`, {
    data: {
      fields: {
        symbols: [
          { slot: 'wild', name: 'Wild', kind: 'wild' },
          { slot: 'thor', name: 'Thor', kind: 'high' },
          { slot: 'scat', name: 'Scatter', kind: 'scatter' },
        ],
      },
    },
  });
  const r1 = await request.put(`${BACKEND}/games/${gameId}/gdd/math-model`, {
    data: { fields: { reels: 4, rows: 3, rtp: '96%', volatility: 'medium', bonus_hit_rate: '1:200' } },
  });
  expect((await r1.json()).realize).toBe('applied');

  // 2. The GDD viewer mirrors the realized paytable with symbol names. Navigate
  //    only now — the doc list fetched on room-open must already contain every
  //    seeded aspect (see createGameRoom's note).
  await enterRoom(page, 'alice', roomName);
  await openPane(page, 'gdd/viewer', 'gdd-aspect-paytable');
  await page.getByTestId('gdd-aspect-paytable').click();
  await expect(page.getByTestId('gdd-mirror-paytable')).toContainText('Thor');

  // 3. Human edit -> touched; next shape edit goes pending + shape-stale pill.
  const doc = await getSlotModelDoc(request, gameId);
  await request.put(`${BACKEND}/games/${gameId}/slot-model`, { data: { model: doc.model } });
  const r2 = await request.put(`${BACKEND}/games/${gameId}/gdd/math-model`, {
    data: { fields: { reels: 3 } },
  });
  expect((await r2.json()).realize).toBe('pending');
  await openPane(page, 'game-config/editor', 'gc-tab-symbols');
  await expect(page.getByTestId('config-shape-stale')).toBeVisible();

  // 4. Re-realize from the GDD viewer clears it and applies the shape everywhere.
  await openPane(page, 'gdd/viewer', 'gdd-aspect-math-model');
  await page.getByTestId('gdd-aspect-math-model').click();
  await page
    .getByTestId('gdd-shape-stale')
    .getByRole('button', { name: /re-realize/i })
    .click();
  await openPane(page, 'game-config/editor', 'gc-tab-symbols');
  await expect(page.getByTestId('config-shape-stale')).toBeHidden();
  const after = await getSlotModelDoc(request, gameId);
  expect(after.model.reels).toHaveLength(3);
  expect(after.shapeStale).toBe(false);
});

// ---------------------------------------------------------------------------
// Test 2 — the sibling staleness axis: a target-field edit (rtp) after a
// stored result flags verdictStale (app/math/realize_flow.py:apply_math_hooks),
// which the Math pane surfaces as a STALE chip next to the verdict badge
// (ResultStrip.tsx). Seeded via the cheapest REST-observable path to a stored
// `result`: POST .../slot-model/curate against a tiny, fast model (mirrors
// math-plugin.spec.ts's "verify only" test) rather than a full tune run.
// ---------------------------------------------------------------------------

const TINY_MODEL = {
  symbols: [
    { id: 0, role: 'normal' },
    { id: 1, role: 'normal' },
    { id: 2, role: 'normal' },
  ],
  reels: [[0, 0, 0, 0, 0, 1, 1, 1, 1, 2]],
  rows: 1,
  paylines: [[0]],
  paytable: {
    entries: [
      { symbol: 1, count: 1, payout: 1 },
      { symbol: 2, count: 1, payout: 5 },
    ],
  },
  bonuses: [],
};

const FAST_SIM_PARAMS = {
  poolSize: 500,
  candidateCount: 20000,
  masterSeed: 2026,
  rtpTolerance: 0.02,
  realizedCorrectionBand: 0.05,
  bonusRateTolerance: 0.25,
};

test('a target-field edit after a stored verdict flags the Math pane STALE chip', async ({ page, request }) => {
  test.setTimeout(120_000);

  const roomName = `gdd-own-stale ${Date.now()}`;
  const { gameId } = await createGameRoom(request, roomName);

  await request.put(`${BACKEND}/games/${gameId}/gdd/math-model`, {
    data: { fields: { rtp: '90%', volatility: 'low', bonus_hit_rate: '1:100' } },
  });
  const slotResp = await request.put(`${BACKEND}/games/${gameId}/slot-model`, {
    data: { model: TINY_MODEL, params: FAST_SIM_PARAMS },
  });
  expect(slotResp.ok()).toBeTruthy();

  // Curate the stored model (real bloom-simulator subprocess, but a tiny model
  // resolves fast) so a `result` lands — the precondition apply_math_hooks
  // checks before it will flip verdictStale.
  const curateResp = await request.post(`${BACKEND}/games/${gameId}/slot-model/curate`);
  expect(curateResp.status()).toBe(202);
  await expect
    .poll(
      async () => {
        const r = await request.get(`${BACKEND}/games/${gameId}/slot-model/result`);
        return await r.json();
      },
      { timeout: 60_000, intervals: [500] },
    )
    .not.toBeNull();

  // Enter the room BEFORE the target edit: RoomRoute's openGameMath joins the
  // math socket room on mount (app/plugins/math/actions.ts), and the pane's own
  // one-time hydrate never reads doc.verdictStale (only sync.ts#refreshDoc does,
  // fired from the `slot_model_changed` socket event) — so the live round-trip
  // below only reaches the chip if the client is already joined when the edit's
  // set_stale_flags write fires that event. Matches the real user flow: the
  // Math pane is open while a target edit lands from elsewhere (GDD/chat).
  await enterRoom(page, 'bob', roomName);
  await openPane(page, 'math/viewer', 'result-verdict');
  await expect(page.getByTestId('result-verdict')).not.toHaveText('—');

  // Target-field (rtp) edit after the stored result -> verdictStale, observed
  // live through the real socket round-trip (not a re-fetch on next pane open).
  const gddResp = await request.put(`${BACKEND}/games/${gameId}/gdd/math-model`, {
    data: { fields: { rtp: '94%' } },
  });
  expect(gddResp.ok()).toBeTruthy();
  const afterDoc = await getSlotModelDoc(request, gameId);
  expect(afterDoc.verdictStale).toBe(true);

  await expect(page.getByTestId('math-verdict-stale')).toBeVisible({ timeout: 10_000 });
});

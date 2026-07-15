import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { seedLocalStorage, BACKEND_URL as BACKEND } from './helpers';

// Drives the family-aware Math pane (SP-C) against a composed@1 game: descriptor
// dispatch, per-state verdict rows, dead-feature detection, and a slots
// regression guard. Mirrors math-plugin.spec.ts's setupGame/openMath helpers —
// the composed twist: seed via PUT /games/{id}/game-definition (not
// /slot-model) so MathStore.family() resolves composed@1 off the compose_store
// doc's existence (app/math/store.py#family). DETERMINISTIC + OFFLINE — no
// cassettes: verify runs the real bloom-simulator curate subprocess. Build
// first for speed: cargo build --release -p bloom-simulator -p bloom-tuner

// Demo composed definition, copied verbatim from
// runtime/server/demo/composed.definition.json.
const COMPOSED_DEF = {
  family: 'composed@1',
  mechanics: [
    {
      id: 'main_reels',
      type: 'reels@1',
      config: {
        strips: [
          [0, 1, 2, 0, 9, 1, 0, 2, 1, 0],
          [1, 0, 2, 9, 0, 1, 2, 0, 0, 1],
          [2, 1, 0, 0, 1, 9, 0, 2, 1, 0],
        ],
        rows: 3,
        symbols: [
          { id: 0, role: 'normal' },
          { id: 1, role: 'normal' },
          { id: 2, role: 'normal' },
          { id: 9, role: 'scatter' },
        ],
        paylines: [
          [0, 0, 0],
          [1, 1, 1],
          [2, 2, 2],
        ],
        paytable: {
          entries: [
            { symbol: 0, count: 3, payout: 5 },
            { symbol: 1, count: 3, payout: 10 },
            { symbol: 2, count: 3, payout: 20 },
            { symbol: 9, count: 3, payout: 2 },
          ],
        },
        events: [{ symbol: 9, min_count: 3, emit: 'scatters:3' }],
      },
    },
    {
      id: 'bonus_meter',
      type: 'meter@1',
      config: { target: 6, count_symbol: 9, reset_on_full: true },
    },
  ],
  states: [
    {
      id: 'base',
      bindings: [{ mechanic: 'main_reels' }, { mechanic: 'bonus_meter' }],
      steps: { budget: 1 },
      script: [{ invoke: 'main_reels.spin' }, { invoke: 'bonus_meter.accumulate' }],
    },
    {
      id: 'fs1',
      bindings: [{ mechanic: 'main_reels', override: { multiplier: 2 } }, { mechanic: 'bonus_meter' }],
      steps: { budget: 'awarded', initial: 8 },
      script: [{ invoke: 'main_reels.spin' }, { invoke: 'bonus_meter.accumulate' }],
    },
    {
      id: 'fs2',
      bindings: [{ mechanic: 'main_reels', override: { multiplier: 3 } }],
      steps: { budget: 5 },
      script: [{ invoke: 'main_reels.spin' }],
    },
  ],
  start: 'base',
  transitions: [
    { from: 'base', on: 'scatters:3', to: 'fs1' },
    { from: 'base', on: 'meter:full', to: 'fs2' },
    { from: 'fs1', on: 'scatters:3', effect: 'steps:add:8' },
    { from: 'fs1', on: 'meter:full', to: 'fs2' },
  ],
  caps: { max_steps: 1000 },
};

// Features-dead variant: every 9 stripped from the reel strips (scatters can
// never land, so the meter's count_symbol never lands either) — fs1/fs2 are
// structurally unreachable, deterministically.
const DEAD_DEF = {
  ...COMPOSED_DEF,
  mechanics: [
    {
      ...COMPOSED_DEF.mechanics[0],
      config: {
        ...COMPOSED_DEF.mechanics[0].config,
        strips: COMPOSED_DEF.mechanics[0].config.strips.map((strip) => strip.filter((s) => s !== 9)),
        events: [] as unknown[],
      },
    },
    COMPOSED_DEF.mechanics[1],
  ],
};

// Forgiving curation params (verdicts stay RTP-stable regardless of which
// composed doc is under test — rtpTolerance 0.5, 'low' vol band is 0–3).
const FORGIVING_PARAMS = {
  poolSize: 500,
  candidateCount: 20000,
  masterSeed: 2026,
  rtpTolerance: 0.5,
  realizedCorrectionBand: 0.05,
  bonusRateTolerance: 0.25,
};

const COMPOSED_INTENT = { rtp: '96%', volatility: 'low' };

// 1 reel, 1 row, 1 payline. strip = 5×sym0, 4×sym1, 1×sym2 (10 cells).
// paytable: sym1@1 → 1, sym2@1 → 5. Closed-form RTP = 0.4·1 + 0.1·5 = 0.9.
// Lifted verbatim from math-plugin.spec.ts (MODEL_09).
const MODEL_09 = {
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

const SLOTS_SIM_PARAMS = {
  poolSize: 500,
  candidateCount: 20000,
  masterSeed: 2026,
  rtpTolerance: 0.02,
  realizedCorrectionBand: 0.05,
  bonusRateTolerance: 0.25,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function enterRoom(page: Page, username: string, roomName: string): Promise<void> {
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await expect(page.getByTestId('room-picker')).toBeVisible();
  await page.getByTestId('room-picker').getByText(roomName, { exact: true }).click();
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
}

/** Seed a composed@1 game: PUT game-definition (not slot-model) is what makes
 * MathStore.family() resolve composed@1 (app/math/store.py#family — GDD intent
 * wins if set, else compose_store doc existence). GDD intent + forgiving
 * curation params round out the seed. */
async function setupComposedGame(page: Page, request: APIRequestContext, username: string, roomName: string, definition: object): Promise<string> {
  const resp = await request.post(`${BACKEND}/rooms`, { data: { name: roomName } });
  expect(resp.ok()).toBeTruthy();
  const room = (await resp.json()) as { id: string; gameId: string };

  const defResp = await request.put(`${BACKEND}/games/${room.gameId}/game-definition`, { data: { definition } });
  expect(defResp.ok()).toBeTruthy();

  const gddResp = await request.put(`${BACKEND}/games/${room.gameId}/gdd/math-model`, { data: { fields: COMPOSED_INTENT } });
  expect(gddResp.ok()).toBeTruthy();

  const slotResp = await request.put(`${BACKEND}/games/${room.gameId}/slot-model`, { data: { params: FORGIVING_PARAMS } });
  expect(slotResp.ok()).toBeTruthy();

  await enterRoom(page, username, roomName);
  return room.gameId;
}

/** Seed a slots@1 game (regression guard — spec 4). */
async function setupSlotsGame(page: Page, request: APIRequestContext, username: string, roomName: string): Promise<string> {
  const resp = await request.post(`${BACKEND}/rooms`, { data: { name: roomName } });
  expect(resp.ok()).toBeTruthy();
  const room = (await resp.json()) as { id: string; gameId: string };

  const gddResp = await request.put(`${BACKEND}/games/${room.gameId}/gdd/math-model`, { data: { fields: { rtp: '90%', volatility: 'low' } } });
  expect(gddResp.ok()).toBeTruthy();

  const slotResp = await request.put(`${BACKEND}/games/${room.gameId}/slot-model`, { data: { model: MODEL_09, params: SLOTS_SIM_PARAMS } });
  expect(slotResp.ok()).toBeTruthy();

  await enterRoom(page, username, roomName);
  return room.gameId;
}

async function openMath(page: Page): Promise<void> {
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-math/viewer').click();
  await expect(page.getByTestId('generate-button')).toBeVisible();
}

// ---------------------------------------------------------------------------
// Scenario 1 — descriptor + strip shape.
// ---------------------------------------------------------------------------

test('descriptor + strip shape: composed game hides the bonus-rate target', async ({ page, request }) => {
  await setupComposedGame(page, request, 'alice', `composed-shape ${Date.now()}`, COMPOSED_DEF);
  await openMath(page);

  await expect(page.getByTestId('target-rtp')).toBeVisible();
  await expect(page.getByTestId('target-volatility')).toBeVisible();
  await expect(page.getByTestId('target-bonus-rate')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Scenario 2 — verify surfaces per-state rows for a live composed game.
// ---------------------------------------------------------------------------

test('verify surfaces per-state rows for a live composed game', async ({ page, request }) => {
  test.setTimeout(300_000);
  await setupComposedGame(page, request, 'bob', `composed-verify ${Date.now()}`, COMPOSED_DEF);
  await openMath(page);

  await page.getByTestId('verify-button').click();

  // state-metrics only renders once !running (ResultStrip.tsx) — waiting on the
  // per-state row is itself the "verify settled" gate. candidateCount 20000 over
  // a 3-reel/3-state composed model is real CPU work, spawned via `cargo run`
  // (SIMULATOR_BIN unset) — generous under shared-machine contention, matching
  // math-plugin.spec.ts's real-subprocess timeout ceiling (up to 300_000).
  await expect(page.getByTestId('state-row-base')).toBeVisible({ timeout: 280_000 });
  await expect(page.getByTestId('state-row-fs1')).toBeVisible();
  await expect(page.getByTestId('dead-feature-warning')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Scenario 3 — dead features are called out (deterministic: structurally
// unreachable states).
// ---------------------------------------------------------------------------

test('dead features are called out for a structurally unreachable state', async ({ page, request }) => {
  test.setTimeout(300_000);
  await setupComposedGame(page, request, 'carol', `composed-dead ${Date.now()}`, DEAD_DEF);
  await openMath(page);

  await page.getByTestId('verify-button').click();

  await expect(page.getByTestId('dead-feature-warning')).toBeVisible({ timeout: 280_000 });
  await expect(page.getByTestId('dead-feature-warning')).toContainText('fs1');
  await expect(page.getByTestId('dead-feature-warning')).toContainText('fs2');
});

// ---------------------------------------------------------------------------
// Scenario 4 — slots regression guard: bonus-rate target present, no
// per-state metrics block renders for a slots@1 game.
// ---------------------------------------------------------------------------

// ponytail: composed tune e2e deferred — add if the composed genome wire ever
// diverges from slots in the pane. Skipped here: the generate pipeline is
// exercised by the backend suite and a composed GA run is minutes-long; the
// wire from tune → pane is identical to slots (same events, same strips),
// which this regression guard already covers.
test('slots regression guard: bonus-rate target present, no per-state metrics render', async ({ page, request }) => {
  test.setTimeout(120_000);
  await setupSlotsGame(page, request, 'dan', `slots-guard ${Date.now()}`);
  await openMath(page);

  await expect(page.getByTestId('target-bonus-rate')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('verify-button').click();
  await expect(page.getByTestId('result-verdict')).toContainText('PASS', { timeout: 90_000 });
  await expect(page.getByTestId('state-metrics')).toHaveCount(0);
});

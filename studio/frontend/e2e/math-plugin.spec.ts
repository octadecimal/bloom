import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { seedLocalStorage, BACKEND_URL as BACKEND } from './helpers';

// Drives the real unified Math pane (Task 8) against a running backend + frontend.
// Local-only; never in CI (see AGENTS.md). DETERMINISTIC + OFFLINE — no cassettes:
// the tune/curate runs the real bloom-tuner/bloom-simulator subprocesses, which are
// masterSeed-deterministic. Build first for speed:
//   cargo build --release -p bloom-simulator -p bloom-tuner
//
// This spec replaces simulator.spec.ts + tuner.spec.ts (author→curate, tune→apply)
// and the math-analytics-*.spec.ts trio (the analytics tabs now live in this same
// pane) — see task-11-brief.md. Generate = tune-then-verify pipeline (the sub-
// project-1 backend spine); Verify only = curate the STORED model (the old
// Simulator pane's role, for after hand-edits in Game Config).

// ---------------------------------------------------------------------------
// Seed data — lifted verbatim from the specs this one replaces (mirror merged
// source, not the plan): DETUNED + FAST_TUNER_PARAMS + FAST_SIM_PARAMS from
// tuner.spec.ts; MODEL_09 from simulator.spec.ts.
// ---------------------------------------------------------------------------

const DETUNED = {
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
      { symbol: 2, count: 1, payout: 1 },
    ],
  },
  bonuses: [],
};

// 1 reel, 1 row, 1 payline. strip = 5×sym0, 4×sym1, 1×sym2 (10 cells).
// paytable: sym1@1 → 1, sym2@1 → 5. Closed-form RTP = 0.4·1 + 0.1·5 = 0.9.
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

const FAST_SIM_PARAMS = {
  poolSize: 500,
  candidateCount: 20000,
  masterSeed: 2026,
  rtpTolerance: 0.02,
  realizedCorrectionBand: 0.05,
  bonusRateTolerance: 0.25,
};

// masterSeed 5 + 200k search spins: deterministically runs 5 generations
// (~0.5s of GA time) before PASS under the final-fidelity-confirmed search —
// wide enough for the live "tuning gen" transient to be observable below.
// Verified offline via tune_json with exactly these inputs.
const FAST_TUNER_PARAMS = {
  masterSeed: 5,
  population: 16,
  maxGenerations: 40,
  searchCandidateCount: 200000,
  finalCandidateCount: 50000,
  elitism: 2,
  mutationRate: 0.25,
  crossoverRate: 0.9,
  stagnationWindow: 12,
  weights: { rtp: 1, volatility: 1, hitRate: 1 },
};

type ILocks = { reels: boolean; paytable: boolean; bonus: boolean };

interface ISetupOpts {
  model: object;
  simParams?: object;
  tunerParams?: object;
  intent?: { rtp: string; volatility: string };
  locks?: ILocks;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seed a game room via the API and navigate to it; returns gameId. Mirrors the
 * setupGame shape from tuner.spec.ts / simulator.spec.ts, generalized so every
 * test can opt into just the seed data it needs (intent, tuner params, locks). */
async function setupGame(page: Page, request: APIRequestContext, username: string, roomName: string, opts: ISetupOpts): Promise<string> {
  const resp = await request.post(`${BACKEND}/rooms`, { data: { name: roomName } });
  expect(resp.ok()).toBeTruthy();
  const room = (await resp.json()) as { id: string; gameId: string };

  if (opts.intent) {
    const gddResp = await request.put(`${BACKEND}/games/${room.gameId}/gdd/math-model`, {
      data: { fields: opts.intent },
    });
    expect(gddResp.ok()).toBeTruthy();
  }

  const slotResp = await request.put(`${BACKEND}/games/${room.gameId}/slot-model`, {
    data: { model: opts.model, params: opts.simParams, locks: opts.locks },
  });
  expect(slotResp.ok()).toBeTruthy();

  if (opts.tunerParams) {
    const tunerResp = await request.put(`${BACKEND}/games/${room.gameId}/tuner`, {
      data: { params: opts.tunerParams },
    });
    expect(tunerResp.ok()).toBeTruthy();
  }

  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await expect(page.getByTestId('room-picker')).toBeVisible();
  await page.getByTestId('room-picker').getByText(roomName, { exact: true }).click();
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
  return room.gameId;
}

async function openMath(page: Page) {
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-math/viewer').click();
  await expect(page.getByTestId('generate-button')).toBeVisible();
}

async function openGameConfig(page: Page) {
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-game-config/editor')).toBeVisible();
  await page.getByTestId('view-open-game-config/editor').click();
  await expect(page.getByTestId('gc-tab-symbols')).toBeVisible();
}

// ---------------------------------------------------------------------------
// Test 1 — the full contract: edit target → Generate → live frames → verdict →
// Apply → Game Config reflects.
// ---------------------------------------------------------------------------

test('full contract: edit target, generate to PASS, apply, Game Config reflects', async ({ page, request }) => {
  test.setTimeout(300_000); // real GA run

  const gameId = await setupGame(page, request, 'alice', `math ${Date.now()}`, {
    model: DETUNED,
    simParams: FAST_SIM_PARAMS,
    tunerParams: FAST_TUNER_PARAMS,
    // NO gdd intent — the pane must surface the gap in place.
  });
  await openMath(page);

  // Missing intent surfaces in place.
  await expect(page.getByTestId('target-gap')).toBeVisible();

  // Fill target — debounced PUT + derive_target round-trip.
  await page.getByTestId('target-rtp').fill('90%');
  await page.getByTestId('target-volatility').selectOption('low');
  await expect(page.getByTestId('target-gap')).toBeHidden({ timeout: 10_000 });
  await expect(page.getByTestId('target-bands')).toBeVisible();

  await page.getByTestId('analytics-tab-evolution').click();
  await page.getByTestId('generate-button').click();

  // Live proof, not just a post-hoc artifact: `run_complete` overwrites `frames`
  // wholesale from the persisted trace (reducers.ts#runLoaded), so a scrubber-
  // visible check alone passes even if nothing streamed live. Catch the
  // transient "tuning gen N/M" text (GenerateBar.tsx) with a tight poll —
  // this exact DETUNED model + FAST_TUNER_PARAMS (masterSeed 5, 200k search
  // spins) deterministically runs 5 generations (~0.5s) before reaching PASS,
  // so there's a real multi-frame window here, not a sub-frame race.
  await expect.poll(() => page.getByTestId('generate-status').innerText(), { intervals: [50], timeout: 5_000 }).toContain('tuning gen');

  await expect(page.getByTestId('scrubber')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('generate-status')).toContainText('done', { timeout: 120_000 });

  await expect(page.getByTestId('result-verdict')).toContainText('PASS');
  const measuredRtp = Number(await page.getByTestId('metric-rtp').innerText());
  expect(measuredRtp).toBeGreaterThanOrEqual(0.9 - FAST_SIM_PARAMS.rtpTolerance);
  expect(measuredRtp).toBeLessThanOrEqual(0.9 + FAST_SIM_PARAMS.rtpTolerance);

  await page.getByTestId('apply-button').click();
  await expect(page.getByTestId('math-applied')).toBeVisible({ timeout: 15_000 });

  // Persisted end-state, not just the UI echo. WHICH symbol the GA raises is
  // search-internal (sym1→2 and sym2→5 are both exact 0.9-RTP solutions);
  // the contract is that the paytable moved off the all-1s detuned seed.
  const after = await request.get(`${BACKEND}/games/${gameId}/slot-model`);
  const doc = (await after.json()) as { model: { paytable: { entries: { symbol: number; payout: number }[] } } };
  expect(doc.model.paytable.entries.some((e) => e.payout > 1)).toBe(true); // raised from the detuned seed

  // Game Config reflects the external write (source: 'tuner').
  await openGameConfig(page);
  await expect(page.getByTestId('gc-sync-pill')).toContainText('tuner', { timeout: 10_000 });
});

// ---------------------------------------------------------------------------
// Test 2 — out-of-pane run re-hydrates the pane; run carries lock chips.
// ---------------------------------------------------------------------------

test('an out-of-pane run re-hydrates the pane with lock chips and an enabled Apply', async ({ page, request }) => {
  test.setTimeout(300_000);

  const gameId = await setupGame(page, request, 'bob', `math ${Date.now()}`, {
    model: DETUNED,
    simParams: FAST_SIM_PARAMS,
    tunerParams: FAST_TUNER_PARAMS,
    intent: { rtp: '90%', volatility: 'low' },
    locks: { reels: false, paytable: false, bonus: true },
  });

  // Trigger the generate pipeline directly via REST — the pane is NOT open.
  const genResp = await request.post(`${BACKEND}/games/${gameId}/math/generate`);
  expect(genResp.status()).toBe(202);

  // Poll analytics/runs until the run lands (mirrors tuner.spec.ts's old poll loop).
  await expect
    .poll(
      async () => {
        const r = await request.get(`${BACKEND}/analytics/runs?game_id=${gameId}`);
        const runs = (await r.json()) as { id: string }[];
        return runs.length;
      },
      { timeout: 120_000, intervals: [1_000] },
    )
    .toBeGreaterThan(0);

  // Now open the pane. It must reflect the already-completed run.
  await openMath(page);
  await expect(page.getByTestId('result-verdict')).toContainText('PASS', { timeout: 10_000 });
  await expect(page.getByTestId('result-lock-chips')).toContainText('bonus');
  await expect(page.getByTestId('apply-button')).toBeEnabled();
});

// ---------------------------------------------------------------------------
// Test 3 — Verify only (the Simulator pane's old role).
// ---------------------------------------------------------------------------

test('verify only curates the stored model to PASS', async ({ page, request }) => {
  test.setTimeout(120_000);

  await setupGame(page, request, 'carol', `math ${Date.now()}`, {
    model: MODEL_09,
    simParams: FAST_SIM_PARAMS,
    intent: { rtp: '90%', volatility: 'low' },
  });
  await openMath(page);

  await page.getByTestId('verify-button').click();

  await expect(page.getByTestId('result-verdict')).toContainText('PASS', { timeout: 90_000 });
  const measuredRtp = Number(await page.getByTestId('metric-rtp').innerText());
  expect(measuredRtp).toBeGreaterThanOrEqual(0.9 - FAST_SIM_PARAMS.rtpTolerance);
  expect(measuredRtp).toBeLessThanOrEqual(0.9 + FAST_SIM_PARAMS.rtpTolerance);
});

// ---------------------------------------------------------------------------
// Test 4 — all-locked disables Generate.
// ---------------------------------------------------------------------------

test('all sections locked disables Generate', async ({ page, request }) => {
  await setupGame(page, request, 'dan', `math ${Date.now()}`, {
    model: MODEL_09,
    intent: { rtp: '90%', volatility: 'low' },
    locks: { reels: true, paytable: true, bonus: true },
  });
  await openMath(page);

  await expect(page.getByTestId('generate-button')).toBeDisabled();
  await expect(page.getByTestId('generate-locked-chip')).toBeVisible();
});

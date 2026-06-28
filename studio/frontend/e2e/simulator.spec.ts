import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { seedLocalStorage, BACKEND_URL as BACKEND } from './helpers';

// Drives the real Simulator UI against a running backend (:8000) + frontend (:4200).
// Local-only; never in CI (see AGENTS.md). DETERMINISTIC + OFFLINE — no replay
// cassettes: the curation runs the real `bloom-simulator` curate_json subprocess,
// whose output is bit-reproducible. (Build it first for speed: `just sim-build`.)
//
// Flow under test (author → curate → reconcile):
//   1. Set the game's GDD math-model design INTENT (rtp + volatility) via the
//      structured-write endpoint.
//   2. Open the Simulator pane, author an executable SlotModel as JSON.
//   3. Curate → the backend derives a TargetSpec from the GDD intent, runs the
//      real curation, and the pane shows the PASS/FAIL verdict.
//
// The toy model below has a closed-form RTP of 0.9 and a per-spin payout std-dev
// of ~1.45 (the "low" volatility band is [0, 3]). So:
//   • intent rtp 90% + volatility low  → measured 0.9 / 1.45 within bands → PASS
//   • intent rtp 50%                   → measured 0.9 far outside ±tol     → FAIL

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

// Small candidate count keeps a real curation to ~a second.
const FAST_PARAMS = {
  poolSize: 500,
  candidateCount: 20000,
  masterSeed: 2026,
  rtpTolerance: 0.02,
  realizedCorrectionBand: 0.05,
  bonusRateTolerance: 0.25,
};

async function setupGame(
  page: Page,
  request: APIRequestContext,
  username: string,
  roomName: string,
  intent: { rtp: string; volatility: string },
): Promise<string> {
  const resp = await request.post(`${BACKEND}/rooms`, { data: { name: roomName } });
  expect(resp.ok()).toBeTruthy();
  const room = (await resp.json()) as { id: string; gameId: string };

  // Design intent lives in the GDD (single source of truth) — set it directly.
  const gddResp = await request.put(`${BACKEND}/games/${room.gameId}/gdd/math-model`, {
    data: { fields: intent },
  });
  expect(gddResp.ok()).toBeTruthy();

  // Curation-only params (not in the GDD) — keep the run small + fast.
  const paramsResp = await request.put(`${BACKEND}/games/${room.gameId}/slot-model`, {
    data: { params: FAST_PARAMS },
  });
  expect(paramsResp.ok()).toBeTruthy();

  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await expect(page.getByTestId('room-picker')).toBeVisible();
  await page.getByTestId('room-picker').getByText(roomName, { exact: true }).click();
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
  return room.gameId;
}

async function openSimulator(page: Page) {
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-simulator/viewer')).toBeVisible();
  await page.getByTestId('view-open-simulator/viewer').click();
  await page.getByTestId('simulator-model-json').waitFor({ state: 'visible', timeout: 5_000 });
}

test('author a model and curate to PASS against GDD intent', async ({ page, request }) => {
  // The backend curates via `cargo run --release` by default, so the FIRST curation
  // in a session pays a cold Rust build that can far exceed Playwright's default 30s
  // per-test cap (which would otherwise make the 90s `expect` below unreachable).
  // Build it ahead of time for speed (`just sim-build`); this headroom covers the
  // cold path on a fresh checkout.
  test.setTimeout(120_000);
  await setupGame(page, request, 'alice', `sim ${Date.now()}`, { rtp: '90%', volatility: 'low' });
  await openSimulator(page);

  await page.getByTestId('simulator-model-json').fill(JSON.stringify(MODEL_09, null, 2));
  await page.getByTestId('curate-button').click();

  await expect(page.getByTestId('curation-status')).toContainText('PASS', { timeout: 90_000 });
  // metric-rtp is the *measured* RTP over the candidate sample, so it carries
  // sampling variance (~0.896) around the 0.9 closed-form / GDD intent. The PASS
  // verdict already proves it landed inside the 0.9 ± rtpTolerance band; assert the
  // rendered metric parses to a number inside that band rather than brittly
  // substring-matching "0.9" (which 0.8963 fails).
  const measuredRtp = Number(await page.getByTestId('metric-rtp').innerText());
  expect(measuredRtp).toBeGreaterThanOrEqual(0.9 - FAST_PARAMS.rtpTolerance);
  expect(measuredRtp).toBeLessThanOrEqual(0.9 + FAST_PARAMS.rtpTolerance);
});

test('a mismatched RTP intent curates to FAIL', async ({ page, request }) => {
  // Same cold-build headroom as the PASS case above (curation may build on first run).
  test.setTimeout(120_000);
  await setupGame(page, request, 'bob', `sim ${Date.now()}`, { rtp: '50%', volatility: 'low' });
  await openSimulator(page);

  await page.getByTestId('simulator-model-json').fill(JSON.stringify(MODEL_09, null, 2));
  await page.getByTestId('curate-button').click();

  await expect(page.getByTestId('curation-status')).toContainText('FAIL', { timeout: 90_000 });
});

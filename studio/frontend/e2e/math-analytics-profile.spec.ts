import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { seedLocalStorage, BACKEND_URL as BACKEND } from './helpers';

// Drives the real Math Analytics pane against a running backend + frontend.
// Local-only; never in CI (see AGENTS.md). DETERMINISTIC + OFFLINE — no cassettes:
// running a real tune (the same real `tune_json` subprocess tuner.spec.ts exercises)
// appends a `math_runs` doc via AnalyticsHub, which is this spec's seed — true
// end-to-end, no seed endpoint needed. Build the tuner binary first for speed:
//   cargo build --release -p bloom-tuner --bin tune_json
//
// Flow: seed a DETUNED model (sym2 pays 1 -> RTP ~0.5) + GDD intent rtp 90% / vol
// low, exactly like tuner.spec.ts. Run the tune to PASS, then open the Math
// Analytics pane and assert the Math Profile tab renders real numbers from the
// persisted run (observable end-state, not a dispatched event).

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

const FAST_SIM_PARAMS = {
  poolSize: 500,
  candidateCount: 20000,
  masterSeed: 2026,
  rtpTolerance: 0.02,
  realizedCorrectionBand: 0.05,
  bonusRateTolerance: 0.25,
};

const FAST_TUNER_PARAMS = {
  masterSeed: 7,
  population: 16,
  maxGenerations: 40,
  searchCandidateCount: 5000,
  finalCandidateCount: 50000,
  elitism: 2,
  mutationRate: 0.25,
  crossoverRate: 0.9,
  stagnationWindow: 12,
  weights: { rtp: 1, volatility: 1, hitRate: 1 },
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

  const gddResp = await request.put(`${BACKEND}/games/${room.gameId}/gdd/math-model`, {
    data: { fields: intent },
  });
  expect(gddResp.ok()).toBeTruthy();

  // Seed the detuned model + curation params (the tuner reads both for the target).
  const slotResp = await request.put(`${BACKEND}/games/${room.gameId}/slot-model`, {
    data: { model: DETUNED, params: FAST_SIM_PARAMS },
  });
  expect(slotResp.ok()).toBeTruthy();

  const tunerResp = await request.put(`${BACKEND}/games/${room.gameId}/tuner`, {
    data: { params: FAST_TUNER_PARAMS },
  });
  expect(tunerResp.ok()).toBeTruthy();

  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await expect(page.getByTestId('room-picker')).toBeVisible();
  await page.getByTestId('room-picker').getByText(roomName, { exact: true }).click();
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
  return room.gameId;
}

async function openTuner(page: Page) {
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-tuner/viewer')).toBeVisible();
  await page.getByTestId('view-open-tuner/viewer').click();
  await page.getByTestId('tune-button').waitFor({ state: 'visible', timeout: 5_000 });
}

async function openMathAnalytics(page: Page) {
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-math-analytics/viewer')).toBeVisible();
  await page.getByTestId('view-open-math-analytics/viewer').click();
}

test('Math Profile renders real numbers from a real tune', async ({ page, request }) => {
  test.setTimeout(180_000);
  await setupGame(page, request, 'dana', `analytics ${Date.now()}`, { rtp: '90%', volatility: 'low' });

  // Run a real tune — this is the spec's seed (AnalyticsHub appends a math_runs
  // doc on completion). Same real tune_json subprocess as tuner.spec.ts.
  await openTuner(page);
  await page.getByTestId('tune-button').click();
  await expect(page.getByTestId('tuning-status')).toContainText('PASS', { timeout: 120_000 });

  // Open the Math Analytics pane. The pane re-fetches run history on open (mirrors
  // the Tuner pane's issue #82 re-hydration), so it picks up the run that completed
  // while the pane was closed.
  await openMathAnalytics(page);
  await expect(page.getByTestId('math-profile-tab')).toBeVisible({ timeout: 15_000 });

  // Math Profile is the default active tab — assert it, don't assume.
  await expect(page.getByTestId('analytics-tab-profile')).toHaveAttribute('aria-selected', 'true');

  // Win-distribution histogram reflects the persisted run: at least one bar drawn.
  const histogram = page.getByTestId('win-distribution');
  await expect(histogram).toBeVisible();
  await expect(histogram.getByTestId('hist-bar').first()).toBeVisible();
  const barCount = await histogram.getByTestId('hist-bar').count();
  expect(barCount).toBeGreaterThan(0);

  // Tail tiles reflect real measured values — max win is a positive multiplier.
  const tailTiles = page.getByTestId('tail-tiles');
  await expect(tailTiles).toBeVisible();
  const maxWinText = await page.getByTestId('stat-max-win').innerText();
  const maxWin = Number(maxWinText.replace(/[^0-9.]/g, ''));
  expect(maxWin).toBeGreaterThan(0);

  // RTP convergence chart rendered from the same run.
  await expect(page.getByTestId('rtp-convergence')).toBeVisible();

  // The tab fills the pane with no inner scroll (docs/design-language.md fit rule +
  // the .bloom-tab-fill utility) — content height must not exceed the container.
  const overflow = await page.getByTestId('math-profile-tab').evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(overflow).toBeLessThanOrEqual(1);
});

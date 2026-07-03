import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { seedLocalStorage, BACKEND_URL as BACKEND } from './helpers';

// Drives the real Compare + Report tabs against a running backend + frontend.
// Local-only; never in CI (see AGENTS.md). DETERMINISTIC + OFFLINE — no cassettes:
// this spec's seed is TWO real `tune_json` subprocess tunes (same real tuner
// tuner.spec.ts / math-analytics-profile.spec.ts / math-analytics-evolution.spec.ts
// exercise), each of which appends a `math_runs` doc via AnalyticsHub — true
// end-to-end, no seed endpoint needed. Build the tuner binary first for speed:
//   cargo build --release -p bloom-tuner --bin tune_json
//
// Flow: seed a DETUNED model (sym2 pays 1 -> RTP ~0.5) + GDD intent rtp 90% / vol
// low, exactly like the sibling specs. Run the tune to PASS from the Tuner pane,
// then nudge the master seed and run a second tune to PASS — two distinct,
// selectable `math_runs` history entries for the same game. Open the Math
// Analytics pane (re-fetches run history on open) and drive the Compare tab's
// mounted RunSelector to pick both runs, then the Report tab's scroll + export.

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

/** Click Tune and wait for it to actually PASS — not just for the status badge
 * to *contain* PASS, which would race a second run: the badge already reads
 * PASS from the first tune before this click. `tuning-progress` appears the
 * instant `onTune` flips status to 'running' (TunerPane.tsx), synchronously
 * before the tune subprocess is even awaited, so waiting for it first proves a
 * *new* run actually started before waiting for the fresh PASS. */
async function runTuneToPass(page: Page) {
  await page.getByTestId('tune-button').click();
  await expect(page.getByTestId('tuning-progress')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('tuning-status')).toContainText('PASS', { timeout: 120_000 });
}

test('Compare overlays two runs and Report scrolls + exports', async ({ page, request }) => {
  test.setTimeout(300_000);
  const gameId = await setupGame(page, request, 'gwen', `analytics-cmp ${Date.now()}`, { rtp: '90%', volatility: 'low' });

  // Run TWO real tunes so there are two `math_runs` history entries to compare.
  await openTuner(page);
  await runTuneToPass(page);

  // Nudge the master seed before the second tune so the two runs are genuinely
  // distinct (cheap: reuses the pane's own seed input, no extra REST plumbing).
  const seedInput = page.getByTestId('param-master-seed');
  await expect(seedInput).toHaveValue(String(FAST_TUNER_PARAMS.masterSeed));
  await seedInput.fill('11');
  await expect(seedInput).toHaveValue('11');
  await runTuneToPass(page);

  // Open the Math Analytics pane — it re-fetches run history on open, so it
  // picks up both runs that completed while it wasn't mounted.
  await openMathAnalytics(page);
  await expect(page.getByTestId('analytics-tab-compare')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('analytics-tab-compare').click();
  await expect(page.getByTestId('analytics-tab-compare')).toHaveAttribute('aria-selected', 'true');

  // The mounted RunSelector reflects both persisted runs.
  const runRows = page.locator('[data-testid^="run-selector-row-"]');
  await expect(runRows).toHaveCount(2, { timeout: 15_000 });

  // Select both — Compare starts empty until at least one pick.
  await expect(page.getByTestId('compare-empty')).toBeVisible();
  await runRows.nth(0).click();
  await runRows.nth(1).click();
  await expect(page.getByTestId('compare-empty')).not.toBeVisible();

  // Observable end-state, not a dispatched event: both overlay charts + the
  // delta table actually reflect two runs.
  //
  // `data-series-count` is a plain React-rendered attribute on OverlayLines
  // (charts/OverlayLines.tsx) — added because the real uPlot legend is NOT a
  // reliable series-count signal here: `legend.show` is fixed at chart
  // *construction* time (UPlotChart.tsx#toOptions) and does not re-evaluate on
  // a later `setData`. Selecting runs one at a time (as above) mounts the
  // chart at 1 series before the second selection brings it to 2, so the
  // legend's own DOM would stay hidden even once two series are plotted.
  const rtpOverlay = page.getByTestId('compare-rtp-overlay');
  const volOverlay = page.getByTestId('compare-vol-overlay');
  await expect(rtpOverlay).toBeVisible();
  await expect(volOverlay).toBeVisible();
  await expect(rtpOverlay).toHaveAttribute('data-series-count', '2');
  await expect(volOverlay).toHaveAttribute('data-series-count', '2');

  const deltaTable = page.getByTestId('delta-table');
  await expect(deltaTable).toBeVisible();
  await expect(deltaTable.locator('[data-testid^="delta-col-"]')).toHaveCount(2);

  // --- Report tab ---
  await page.getByTestId('analytics-tab-report').click();
  await expect(page.getByTestId('analytics-tab-report')).toHaveAttribute('aria-selected', 'true');
  const reportTab = page.getByTestId('report-tab');
  await expect(reportTab).toBeVisible();

  // Report is the one intentionally SCROLLABLE tab (unlike Math Profile/Evolution's
  // fixed no-scroll `.bloom-tab-fill` root) — assert the scroll container's content
  // actually overflows, then scroll it and confirm the position changed.
  const { scrollHeight, clientHeight } = await reportTab.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
  expect(scrollHeight).toBeGreaterThan(clientHeight);
  await reportTab.evaluate((el) => {
    el.scrollTop = 250;
  });
  const scrollTop = await reportTab.evaluate((el) => el.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);

  // Export triggers a real browser download — the observable end-state for a
  // client-side rasterize-and-download action (ReportTab.tsx#handleExport).
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), page.getByTestId('export-button').click()]);
  expect(download.suggestedFilename()).toMatch(/\.(pdf|png)$/);
});

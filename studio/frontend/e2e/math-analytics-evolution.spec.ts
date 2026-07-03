import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { seedLocalStorage, BACKEND_URL as BACKEND } from './helpers';

// Drives the real Evolution tab against a running backend + frontend. Local-only; never
// in CI (see AGENTS.md). DETERMINISTIC + OFFLINE — no cassettes: runs the same real
// `tune_json` subprocess tuner.spec.ts / math-analytics-profile.spec.ts exercise. Build
// the tuner binary first for speed:
//   cargo build --release -p bloom-tuner --bin tune_json
//
// Flow: seed the same DETUNED model + GDD intent as the sibling specs (sym2 pays 1 ->
// RTP ~0.5, target 90% RTP / low vol). Open the Math Analytics pane and switch to the
// Evolution tab BEFORE starting the tune — the pane's socket only joins the per-game
// `analytics` room on mount (see actions.ts#openGameAnalytics /
// socketClient.ts#createAnalyticsSocket), and `frames` are populated *exclusively* over
// that socket (`analytics_progress` while a tune runs, `run_complete` freezing them from
// the persisted trace — reducers.ts#progressFrame / #runLoaded). A REST re-fetch after
// the fact does NOT backfill frames, so unlike the Math Profile spec this one must have
// the pane open first, then trigger the tune.
//
// The tune is started via the same out-of-pane REST path tuner.spec.ts's issue #82 test
// exercises (`POST /tuner/tune`), which decouples this spec entirely from the Tuner
// pane's UI/layout — only the Math Analytics pane's socket join matters here.
//
// With this exact seed model + FAST_TUNER_PARAMS + masterSeed 7 the GA is deterministic
// (SplitMix64, common random numbers) and was confirmed via a direct backend probe to
// reliably run 9 generations (0..8) before reaching PASS — comfortably "multiple
// generations" for the assertions below.

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

async function openMathAnalytics(page: Page) {
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-math-analytics/viewer')).toBeVisible();
  await page.getByTestId('view-open-math-analytics/viewer').click();
}

test('Evolution tab streams a real tune live and the scrubber replays it', async ({ page, request }) => {
  test.setTimeout(180_000);
  const gameId = await setupGame(page, request, 'erin', `analytics-evo ${Date.now()}`, { rtp: '90%', volatility: 'low' });

  // Open the pane and switch to Evolution BEFORE starting the tune, so the analytics
  // socket is already joined to this game's room when `analytics_progress`/`run_complete`
  // start arriving.
  await openMathAnalytics(page);
  await expect(page.getByTestId('analytics-tab-evolution')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('analytics-tab-evolution').click();
  await expect(page.getByTestId('analytics-tab-evolution')).toHaveAttribute('aria-selected', 'true');

  // Starting point: no generations recorded yet for this fresh game.
  await expect(page.getByTestId('evolution-no-data')).toBeVisible({ timeout: 10_000 });

  // Trigger the real tune from outside the pane (mirrors tuner.spec.ts's issue #82
  // REST path) — the pane's socket join is all that's required to observe it.
  const tuneResp = await request.post(`${BACKEND}/games/${gameId}/tuner/tune`);
  expect(tuneResp.status()).toBe(202);

  // Observable end-state, not a dispatched event: once the tune completes, `run_complete`
  // freezes the Evolution charts from the persisted trace. This is only reachable if
  // streaming + the trace replay actually worked end-to-end.
  const scrubber = page.getByTestId('scrubber');
  await expect(scrubber).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('fitness-landscape')).toBeVisible();
  await expect(page.getByTestId('gene-heatmap')).toBeVisible();

  // IMPORTANT — gate on the FROZEN run before reading any value off the scrubber. The
  // scrubber becomes visible on the FIRST `analytics_progress` frame (generation 0),
  // long before the run freezes: the backend emits one `analytics_progress` per
  // generation and the live playhead advances Gen 1/1 → Gen 2/2 → … as they stream. Only
  // `run_complete` pins the playhead to the final generation as "Paused" (not "Live") —
  // see reducers.ts#runLoaded. So this retrying `toContainText('Paused')` is what waits
  // for the frozen end-state; capturing `max` / the "Gen N/N" label mid-stream would race
  // the advancing live playhead (a non-retrying `maxGen` read could catch gen 0, and a
  // captured "Gen 2/2" would never match once the label advanced to Gen 8/8).
  await expect(scrubber).toContainText('Paused');

  const slider = scrubber.getByRole('slider');
  const maxGen = Number(await slider.getAttribute('max'));
  expect(maxGen).toBeGreaterThan(0); // multiple generations recorded, not just gen 0

  // Frozen playhead sits on the final generation.
  const genLabel = scrubber.locator('span').first();
  await expect(genLabel).toHaveText(`Gen ${maxGen}/${maxGen}`);

  // Scrub back to the earliest generation and assert the rendered view changes.
  await slider.focus();
  await slider.press('Home');
  await expect(genLabel).toHaveText(`Gen 0/${maxGen}`);

  // The gene heatmap's highlighted column moved with the scrub — proves the frames +
  // scrub reducer path drives the actual chart render, not just the label text.
  await expect(page.locator('[data-testid="gene-heatmap-cell"][data-generation="0"][data-selected="true"]').first()).toBeVisible();
});

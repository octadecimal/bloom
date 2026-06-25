import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { seedLocalStorage, BACKEND_URL as BACKEND } from './helpers';

// Drives the real Tuner UI against a running backend + frontend. Local-only; never
// in CI (see AGENTS.md). DETERMINISTIC + OFFLINE — no cassettes: the tune runs the
// real bloom-tuner tune_json subprocess. Build first for speed:
//   cargo build --release -p bloom-tuner --bin tune_json
//
// Flow: seed a DETUNED model (sym2 pays 1 -> RTP ~0.5) + GDD intent rtp 90% / vol
// low. The tuner must raise payouts to reach 0.9 ± tol -> PASS. Then Apply writes
// the tuned model back into the slot-model store (verified via the API).

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

test('tune a detuned model to PASS and apply it back', async ({ page, request }) => {
  test.setTimeout(180_000);
  const gameId = await setupGame(page, request, 'alice', `tuner ${Date.now()}`, { rtp: '90%', volatility: 'low' });
  await openTuner(page);

  await page.getByTestId('tune-button').click();
  await expect(page.getByTestId('tuning-status')).toContainText('PASS', { timeout: 120_000 });

  const measuredRtp = Number(await page.getByTestId('metric-rtp').innerText());
  expect(measuredRtp).toBeGreaterThanOrEqual(0.9 - FAST_SIM_PARAMS.rtpTolerance);
  expect(measuredRtp).toBeLessThanOrEqual(0.9 + FAST_SIM_PARAMS.rtpTolerance);

  // Apply writes the tuned model back into the slot-model store.
  await page.getByTestId('apply-button').click();
  await expect(page.getByTestId('tuner-applied')).toBeVisible({ timeout: 15_000 });

  const after = await request.get(`${BACKEND}/games/${gameId}/slot-model`);
  const doc = (await after.json()) as { model: { paytable: { entries: { symbol: number; payout: number }[] } } };
  const sym2 = doc.model.paytable.entries.find((e) => e.symbol === 2)!;
  expect(sym2.payout).toBeGreaterThan(1); // raised from the detuned seed
});

test('an unreachable RTP intent reports NEAR-MISS', async ({ page, request }) => {
  test.setTimeout(180_000);
  await setupGame(page, request, 'bob', `tuner ${Date.now()}`, { rtp: '5000%', volatility: 'low' });
  await openTuner(page);

  await page.getByTestId('tune-button').click();
  await expect(page.getByTestId('tuning-status')).toContainText('NEAR-MISS', { timeout: 120_000 });
  await expect(page.getByTestId('tuner-missed')).toContainText('rtp');
});

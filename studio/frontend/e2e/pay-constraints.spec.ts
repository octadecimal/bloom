// Constraint-flow e2e (spec 2026-07-09 §6, Plan 2): chat sets a pay-relation
// constraint → derive_target compiles it through the model_id join key → the GA
// repairs every candidate to honor it → the tuned paytable proves it.
//
// Cassettes (studio/backend/tests/fixtures/replay/run/):
//   pay-constraint-set.json — key "the gold coin should pay the most"
//                             (plain chat → design-router → set_gdd_fields on paytable)
//   tuner-chat-tune.json    — key "tune the slot math" (existing; /tune-math)
//
// Seeding ORDER matters: PUT slot-model FIRST (marks the doc touched), THEN the
// GDD aspects. A GDD shape write (symbols-reels) against an untouched template
// doc would re-realize and overwrite the seeded DETUNED model; on a touched doc
// it only sets shape_stale (a harmless pill here — the tune still runs the GA on
// the stored DETUNED model against the constraint-bearing derived target).

import { test, expect } from '@playwright/test';
import { seedLocalStorage, BACKEND_URL as BACKEND } from './helpers';

// DETUNED model + FAST params copied verbatim from tuner-chat.spec.ts. The one
// exact 90%-RTP solution that also satisfies "sym2 top-paying" is sym1=1, sym2=5
// (0.4·1 + 0.1·5 = 0.9); the rival un-constrained solution sym1=2, sym2=1 is now
// forbidden by repair, so the GA is pushed to the constrained one.
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
  maxAttempts: 1,
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

test('pay constraint: chat → GDD → tune honors top-paying', async ({ page, request }) => {
  // Real tune runs the bloom-tuner GA subprocess: allow generous time.
  test.setTimeout(300_000);

  const roomName = `PayCon ${Date.now()}`;
  const resp = await request.post(`${BACKEND}/rooms`, { data: { name: roomName } });
  expect(resp.ok()).toBeTruthy();
  const room = (await resp.json()) as { id: string; gameId: string };

  // 1. Slot model FIRST (touched=true), then tuner params + GDD intent + the
  //    join-keyed symbol roster (model_id 1/2 resolves the "sym2" constraint).
  const slotResp = await request.put(`${BACKEND}/games/${room.gameId}/slot-model`, {
    data: { model: DETUNED, params: FAST_SIM_PARAMS },
  });
  expect(slotResp.ok()).toBeTruthy();
  await request.put(`${BACKEND}/games/${room.gameId}/tuner`, { data: { params: FAST_TUNER_PARAMS } });
  await request.put(`${BACKEND}/games/${room.gameId}/gdd/math-model`, {
    data: { fields: { rtp: '90%', volatility: 'low' } },
  });
  await request.put(`${BACKEND}/games/${room.gameId}/gdd/symbols-reels`, {
    data: {
      fields: {
        symbols: [
          { slot: 'sym1', name: 'Anchor', kind: 'low', model_id: 1 },
          { slot: 'sym2', name: 'Gold Coin', kind: 'high', model_id: 2 },
        ],
      },
    },
  });

  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username: 'alice' } }));
  await page.goto('/');
  await expect(page.getByTestId('room-picker')).toBeVisible();
  await page.getByTestId('room-picker').getByText(roomName, { exact: true }).click();
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();

  // 2. Plain chat → design-router → set_gdd_fields on paytable.pay_constraints.
  //    Cassette key "the gold coin should pay the most". Only the tool NAME and
  //    the streamed final render in the feed (tool results never render there).
  const composer = page.getByTestId('chat-composer');
  await expect(composer).toBeVisible({ timeout: 10_000 });
  await composer.fill('the gold coin should pay the most');
  await composer.press('Enter');
  const feed = page.getByTestId('chat-messages');
  await expect(feed).toContainText('set_gdd_fields', { timeout: 30_000 });
  await expect(feed).toContainText(/top-paying/i, { timeout: 30_000 });

  // Persisted end-state, not just dispatch. There is no per-aspect GDD GET;
  // /gdd/docs returns every aspect doc. The table normalizer fills the unset
  // columns (count, value) with "" for a top-paying row.
  const docsResp = await request.get(`${BACKEND}/games/${room.gameId}/gdd/docs`);
  expect(docsResp.ok()).toBeTruthy();
  const docs = (await docsResp.json()) as { aspect: string; data: { pay_constraints?: unknown[] } }[];
  const paytable = docs.find((d) => d.aspect === 'paytable');
  expect(paytable?.data.pay_constraints).toEqual([{ symbol: 'sym2', relation: 'top-paying', count: '', value: '' }]);

  // 3. Tune via /tune-math (existing cassette; real GA — offline + deterministic).
  await composer.fill('/tune-math tune the slot math');
  await composer.press('Enter');
  await expect(feed).toContainText('tune_math', { timeout: 30_000 });
  await expect(feed).toContainText(/verdict is above/i, { timeout: 120_000 });

  // 4. PASS in the Math pane; the tuned paytable honors the constraint.
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-math/viewer')).toBeVisible({ timeout: 5_000 });
  await page.getByTestId('view-open-math/viewer').click();
  await expect(page.getByTestId('result-verdict')).toContainText('PASS', { timeout: 10_000 });

  // The tuner wire (tuner_view in app/math/models.py): { result: { tunedModel } },
  // tunedModel is the raw Rust SlotModel dict — paytable.entries[{symbol,count,payout}].
  const tunerResp = await request.get(`${BACKEND}/games/${room.gameId}/tuner`);
  expect(tunerResp.ok()).toBeTruthy();
  const t = (await tunerResp.json()) as {
    result: { tunedModel: { paytable: { entries: { symbol: number; count: number; payout: number }[] } } };
  };
  const entries = t.result.tunedModel.paytable.entries;
  const pay = (sym: number) => entries.find((e) => e.symbol === sym)!.payout;
  expect(pay(2)).toBeGreaterThanOrEqual(pay(1)); // sym2 top-paying (ties allowed by repair)
  expect(pay(2)).toBeGreaterThan(1); // and the tune actually moved off the all-1s seed
});

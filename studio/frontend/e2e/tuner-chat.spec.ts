// REQUIRES a recorded run cassette in replay mode before this spec can pass.
// See the recording runbook: sdd/task-7-runbook.md (in the tuner-agent worktree's
// .git/worktrees/tuner-agent/sdd/ directory).
//
// Cassette files expected (relative to studio/backend/tests/fixtures/replay/run/):
//   tuner-chat-tune.json   — prompt: "/tune-math tune the slot math"
//   tuner-chat-apply.json  — prompt: "apply it"
//
// Stack (BLOOM_PORT_OFFSET=1): backend replay :8001, frontend :4201.
// Run: BLOOM_PORT_OFFSET=1 npx playwright test --config=studio/frontend/playwright.config.ts e2e/tuner-chat.spec.ts
//      (or equivalently: just e2e -- tuner-chat.spec.ts from the worktree root)
//
// Flow:
//   1. Seed a game with a DETUNED slot model + GDD math-model intent (90% RTP, low vol).
//   2. Open the game room chat; invoke /tune-math tune the slot math.
//   3. Agent calls read_tuner_setup + tune_slot_model (real GA run — offline+deterministic).
//      The tool-result text "Tuned to PASS" appears in the chat feed.
//   4. User sends "apply it"; agent calls apply_tuned_model → interrupt() approval gate.
//      The approval-card appears. User approves.
//   5. Write-back assertion: GET /games/:id/slot-model confirms the model changed from
//      the detuned seed (sym2 payout raised from 1).

import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { seedLocalStorage, BACKEND_URL as BACKEND } from './helpers';

// ---------------------------------------------------------------------------
// Seed data — mirrors tuner.spec.ts exactly (same DETUNED model + FAST params).
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seed a game room via the API and navigate to it; returns gameId. */
async function setupGame(page: Page, request: APIRequestContext, username: string, roomName: string): Promise<string> {
  const resp = await request.post(`${BACKEND}/rooms`, { data: { name: roomName } });
  expect(resp.ok()).toBeTruthy();
  const room = (await resp.json()) as { id: string; gameId: string };

  // GDD math-model intent: 90% RTP, low volatility — same target as tuner.spec.ts.
  const gddResp = await request.put(`${BACKEND}/games/${room.gameId}/gdd/math-model`, {
    data: { fields: { rtp: '90%', volatility: 'low' } },
  });
  expect(gddResp.ok()).toBeTruthy();

  // Detuned slot model: sym2 payout=1 → RTP well below 90%.
  const slotResp = await request.put(`${BACKEND}/games/${room.gameId}/slot-model`, {
    data: { model: DETUNED, params: FAST_SIM_PARAMS },
  });
  expect(slotResp.ok()).toBeTruthy();

  // Fast tuner GA params so the real tune completes quickly.
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

/** Send text via the chat composer (Enter to submit). */
async function composerSend(page: Page, text: string): Promise<void> {
  const composer = page.getByTestId('chat-composer');
  await expect(composer).toBeVisible({ timeout: 10_000 });
  await composer.fill(text);
  await composer.press('Enter');
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test('chat tune-math: tune → PASS verdict → approve apply → slot model updated', async ({ page, request }) => {
  // Real tune runs the bloom-tuner GA subprocess: allow generous time.
  test.setTimeout(300_000);

  const gameId = await setupGame(page, request, 'alice', `TunerChat ${Date.now()}`);
  const feed = page.getByTestId('chat-messages');

  // -------------------------------------------------------------------------
  // 1. Invoke the tune-math skill.
  //    Cassette key: "/tune-math tune the slot math" (prompt-keyed run cassette).
  //    The replay model calls read_tuner_setup + tune_slot_model (bound to the
  //    tune-math skill). tune_slot_model awaits the real GA — it is offline and
  //    deterministic, so no cassette is needed for it. The tool result text
  //    "Tuned to PASS" is produced by the tool function itself, not the LLM.
  // -------------------------------------------------------------------------
  await composerSend(page, '/tune-math tune the slot math');

  // The run steps appear in the chat feed: first the tool calls, then the final.
  // Confirm the tool names show (deterministic from replay cassette).
  await expect(feed).toContainText('tune_slot_model', { timeout: 30_000 });

  // "Tuned to PASS" is the deterministic tool-result string from tune_slot_model
  // (see agent_tools.py:560). It appears in the tool-result step rendered in the
  // RunTurnBlock. This is NOT free LLM prose — it is our own formatted string.
  await expect(feed).toContainText(/Tuned to PASS/i, { timeout: 120_000 });

  // -------------------------------------------------------------------------
  // 2. (Optional) Confirm the Tuner pane reflects the completed run.
  //    tuning_complete socket event is emitted by TunerHub.request_tune regardless
  //    of whether the trigger is REST or chat. Open the pane and check the status.
  //    This step is best-effort — the main contract is the chat feed text above.
  // -------------------------------------------------------------------------
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-tuner/viewer')).toBeVisible({ timeout: 5_000 });
  await page.getByTestId('view-open-tuner/viewer').click();
  await expect(page.getByTestId('tuning-status')).toContainText('PASS', { timeout: 10_000 });
  // Close the Tuner pane (or leave it open); navigate back to chat.
  // The approval flow below does not require the Tuner pane to be closed.

  // -------------------------------------------------------------------------
  // 3. Tell the agent to apply the tuned model.
  //    Cassette key: "apply it" (prompt-keyed run cassette).
  //    The replay model calls apply_tuned_model (bound to tune-math).
  //    apply_tuned_model triggers interrupt() → the approval-card surfaces.
  // -------------------------------------------------------------------------
  await composerSend(page, 'apply it');

  // The approval card renders inside the RunTurnBlock (step type="approval").
  // Its label: "Apply the tuned model to the slot model? This overwrites the
  // current realization." (agent_tools.py:589–590).
  const approval = page.getByTestId('approval-card');
  await expect(approval).toBeVisible({ timeout: 20_000 });
  await expect(approval).toContainText(/overwrites/i);

  // Approve: the apply_tuned_model tool calls sim_store.put(game_id, model=tuned).
  await approval.getByRole('button', { name: /approve/i }).click();

  // The approval card resolves (shows "Approved") and the run completes.
  await expect(approval).toContainText(/approved/i, { timeout: 15_000 });

  // -------------------------------------------------------------------------
  // 4. Assert write-back: the slot model changed from the detuned seed.
  //    sym2.payout was 1 in the seed; the tuner raises it to hit ~90% RTP.
  // -------------------------------------------------------------------------
  const after = await request.get(`${BACKEND}/games/${gameId}/slot-model`);
  expect(after.ok()).toBeTruthy();
  const doc = (await after.json()) as {
    model: { paytable: { entries: { symbol: number; count: number; payout: number }[] } };
  };
  const sym2 = doc.model.paytable.entries.find((e) => e.symbol === 2);
  expect(sym2).toBeDefined();
  expect(sym2!.payout).toBeGreaterThan(1);
});

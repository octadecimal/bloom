// REQUIRES a recorded run cassette in replay mode before this spec can pass.
// See the recording runbook: sdd/task-7-runbook.md (in the tuner-agent worktree's
// .git/worktrees/tuner-agent/sdd/ directory).
//
// Cassette files expected (relative to studio/backend/tests/fixtures/replay/run/):
//   tuner-chat-tune.json   — prompt key: "tune the slot math"
//   tuner-chat-apply.json  — prompt key: "apply it"
//
// Prompt keys are the bare prose the agent receives (invocation_text strips the
// "/tune-math " slash prefix), normalized lower/whitespace-collapsed. Both apply
// and tune are invoked via the /tune-math skill so the four tuner tools are BOUND:
// the replay model filters a cassette's tool_calls to the active skill's tool set,
// and plain (non-slash) chat in a game room routes to the design-router, which
// binds only the GDD tools — apply_tuned_model would be filtered out there.
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
//      the detuned seed (some payout raised from the all-1s paytable).

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
  //    Cassette key: "tune the slot math" (prose only; the slash prefix is stripped).
  //    The replay model calls read_tuner_setup + tune_slot_model (bound to the
  //    tune-math skill). tune_slot_model awaits the real GA — it is offline and
  //    deterministic, so no cassette is needed for it.
  // -------------------------------------------------------------------------
  await composerSend(page, '/tune-math tune the slot math');

  // The run steps appear in the chat feed as concise tool lines (tool NAME only —
  // RunTurnBlock's ToolLine renders the name, not the tool-result body). Confirm the
  // tune tool ran, then wait for the run to settle by its streamed final summary.
  await expect(feed).toContainText('read_tuner_setup', { timeout: 30_000 });
  await expect(feed).toContainText('tune_slot_model', { timeout: 30_000 });
  await expect(feed).toContainText(/verdict is above/i, { timeout: 120_000 });

  // -------------------------------------------------------------------------
  // 2. Confirm the PASS verdict in the Math pane.
  //    The tool RESULT ("Tuned to PASS …") is NOT shown in the chat feed (tool
  //    results don't render there). The deterministic verdict surfaces in the Math
  //    pane instead: opening the pane re-hydrates from the persisted run/tune
  //    result (the pane never watched this chat-driven tune live) via the same
  //    re-hydration port that PR #99 added to the old Tuner pane. This mirrors
  //    tuner.spec.ts's PASS assertion for the same DETUNED seed + FAST params, so
  //    PASS is deterministic here.
  // -------------------------------------------------------------------------
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-math/viewer')).toBeVisible({ timeout: 5_000 });
  await page.getByTestId('view-open-math/viewer').click();
  await expect(page.getByTestId('result-verdict')).toContainText('PASS', { timeout: 10_000 });
  // Opening the Math pane covered the chat composer. Re-activate the chat pane via
  // the View menu (openPane is a singleton — it focuses the pane if already open) so
  // the composer is visible again for the apply turn.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-llm-chat/room').click();
  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: 10_000 });

  // -------------------------------------------------------------------------
  // 3. Tell the agent to apply the tuned model.
  //    Cassette key: "apply it" (prose only). Invoked via the /tune-math skill so
  //    apply_tuned_model is BOUND — plain "apply it" would route to the design-router,
  //    whose tool set excludes the tuner tools, and the call would be filtered out.
  //    apply_tuned_model triggers interrupt() → the approval-card surfaces.
  // -------------------------------------------------------------------------
  await composerSend(page, '/tune-math apply it');

  // The approval card renders inside the RunTurnBlock (step type="approval").
  // Its label: "Apply the tuned model to the slot model? This overwrites the
  // current realization." (agent_tools.py:589–590).
  const approval = page.getByTestId('approval-card');
  await expect(approval).toBeVisible({ timeout: 20_000 });
  await expect(approval).toContainText(/overwrites/i);

  // Approve: the apply_tuned_model tool calls sim_store.put(game_id, model=tuned).
  await approval.getByRole('button', { name: /approve/i }).click();

  // The approval card resolves (shows "Approved").
  await expect(approval).toContainText(/approved/i, { timeout: 15_000 });

  // Wait for the run to FINISH before asserting the write-back. "Approved" renders
  // when the approval step completes, but apply_tuned_model's sim_store.put runs
  // afterward, on graph resume — the tool's final summary ("Applied the tuned
  // model…") streams only once the put has committed, so it gates the GET below
  // and removes the read-before-write race.
  await expect(feed).toContainText(/Applied the tuned model/i, { timeout: 15_000 });

  // -------------------------------------------------------------------------
  // 4. Assert write-back: the slot model changed from the detuned seed.
  //    Every payout was 1 in the seed; the tuner raises at least one to hit
  //    ~90% RTP. WHICH symbol gets raised is search-internal (there are two
  //    exact solutions: sym1→2 or sym2→5), so assert the contract — the
  //    paytable moved off the all-1s seed — not one particular solution.
  // -------------------------------------------------------------------------
  const after = await request.get(`${BACKEND}/games/${gameId}/slot-model`);
  expect(after.ok()).toBeTruthy();
  const doc = (await after.json()) as {
    model: { paytable: { entries: { symbol: number; count: number; payout: number }[] } };
  };
  expect(doc.model.paytable.entries.some((e) => e.payout > 1)).toBe(true);
});

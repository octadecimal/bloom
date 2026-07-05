import { mathSlice, makeInitialState, type ITargetFields, type ITuningParams, type ICurationParams } from './state';
import {
  applyTuned,
  cancelGenerate,
  curate,
  fetchRuns,
  generate,
  getGddDocs,
  getSlotModel,
  getTuner,
  putCurationParams,
  putMathModelFields,
  putTunerParams,
} from './restClient';
import { mathSock } from './socketClient';
import { fieldsFromGddData, refreshTarget } from './sync';
import { scrubTo, selectRun as selectRunReducer, toggleRunSelected as toggleRunSelectedReducer } from './reducers';
import type { IMathState } from './state';

/** Connects the lazily-created analytics socket (mirrors `initTuner`). Joining/
 * leaving the per-game room happens in `openGameMath`/`closeGameMath`
 * below, once a game is actually open. */
export function initMath(): void {
  mathSock().connect();
}

export const TARGET_DEBOUNCE_MS = 600;
let targetTimer: ReturnType<typeof setTimeout> | null = null;

export async function openGameMath(gameId: string): Promise<void> {
  if (targetTimer) {
    clearTimeout(targetTimer);
    targetTimer = null; // room→room nav must not flush a stale debounce into the new game
  }
  const s = mathSlice();
  s.set({ ...makeInitialState(), activeGameId: gameId, loadStatus: 'loading' } as never);
  mathSock().joinMath(gameId);
  try {
    const [doc, tuner, gddDocs, runs] = await Promise.all([getSlotModel(gameId), getTuner(gameId), getGddDocs(gameId), fetchRuns(gameId)]);
    if (s.activeGameId.get() !== gameId) return;
    s.locks.set(doc.locks);
    s.curationParams.set(doc.params);
    s.verifyResult.set(doc.result);
    s.tunerParams.set(tuner.params);
    s.tuneResult.set(tuner.result);
    const mm = gddDocs.find((d) => d.aspect === 'math-model');
    s.targetFields.set(mm ? fieldsFromGddData(mm.data) : { rtp: '', volatility: '', bonusHitRate: '' });
    if (mm) s.gddWatermark.set(mm.updatedAt);
    s.runs.set(runs as never);
    s.selectedRunId.set(runs[0]?.id ?? null);
    s.loadStatus.set('idle');
    await refreshTarget(gameId);
  } catch {
    s.loadStatus.set('error');
  }
}

export function closeGameMath(): void {
  if (targetTimer) {
    clearTimeout(targetTimer);
    targetTimer = null;
  }
  const prev = mathSlice().activeGameId.get();
  if (prev) mathSock().leaveMath(prev);
  mathSlice().set(makeInitialState() as never);
}

/** Re-fetch run history (pane re-open; mirrors the old analytics REST-only refresh). */
export async function refreshRuns(gameId: string): Promise<void> {
  try {
    const runs = await fetchRuns(gameId);
    const s = mathSlice();
    if (s.activeGameId.get() !== gameId) return;
    s.runs.set(runs as never);
    if (!s.selectedRunId.get()) s.selectedRunId.set(runs[0]?.id ?? null);
  } catch {
    // keep current list
  }
}

export function editTargetField(key: keyof ITargetFields, value: string): void {
  const s = mathSlice();
  const cur = (s.targetFields.get({ noproxy: true }) as ITargetFields | null) ?? { rtp: '', volatility: '', bonusHitRate: '' };
  s.targetFields.set({ ...cur, [key]: value });
  s.targetSaveStatus.set('saving');
  if (targetTimer) clearTimeout(targetTimer);
  targetTimer = setTimeout(() => void flushTargetSave(), TARGET_DEBOUNCE_MS);
}

export async function flushTargetSave(): Promise<void> {
  const s = mathSlice();
  const gameId = s.activeGameId.get();
  const fields = s.targetFields.get({ noproxy: true }) as ITargetFields | null;
  if (!gameId || !fields) return;
  const payload: Record<string, unknown> = {};
  if (fields.rtp.trim()) payload.rtp = fields.rtp.trim();
  if (fields.volatility.trim()) payload.volatility = fields.volatility.trim();
  if (fields.bonusHitRate.trim()) payload.bonus_hit_rate = fields.bonusHitRate.trim();
  if (Object.keys(payload).length === 0) {
    s.targetSaveStatus.set('idle'); // clearing all fields must not strand "saving…"
    return;
  }
  try {
    const doc = await putMathModelFields(gameId, payload);
    if (s.activeGameId.get() !== gameId) return; // game switched while the PUT was in flight
    if (doc.updatedAt > s.gddWatermark.get()) s.gddWatermark.set(doc.updatedAt);
    s.targetSaveStatus.set('saved');
    await refreshTarget(gameId);
  } catch {
    if (s.activeGameId.get() !== gameId) return;
    s.targetSaveStatus.set('error');
  }
}

export async function generateMath(): Promise<void> {
  const s = mathSlice();
  const gameId = s.activeGameId.get();
  if (!gameId) return;
  try {
    const params = s.tunerParams.get({ noproxy: true }) as ITuningParams | null;
    if (params) await putTunerParams(gameId, params);
    s.genStatus.set('tuning');
    s.genFailure.set(null);
    s.genProgress.set(null);
    s.applied.set(false);
    await generate(gameId);
  } catch (e) {
    s.genStatus.set('failed');
    s.genFailure.set(e instanceof Error ? e.message : 'generate failed');
  }
}

export async function verifyMath(): Promise<void> {
  const s = mathSlice();
  const gameId = s.activeGameId.get();
  if (!gameId) return;
  try {
    const params = s.curationParams.get({ noproxy: true }) as ICurationParams | null;
    if (params) await putCurationParams(gameId, params);
    s.verifyStatus.set('running');
    s.verifyFailure.set(null);
    s.verifyProgress.set({ phase: 'starting', done: null, total: null });
    await curate(gameId);
  } catch {
    s.verifyStatus.set('error');
    s.verifyProgress.set(null);
  }
}

export async function applyMath(): Promise<void> {
  const s = mathSlice();
  const gameId = s.activeGameId.get();
  if (!gameId) return;
  try {
    await applyTuned(gameId);
    s.applied.set(true);
  } catch {
    s.genFailure.set('apply failed');
  }
}

export async function cancelMath(): Promise<void> {
  const s = mathSlice();
  const gameId = s.activeGameId.get();
  if (!gameId) return;
  const prev = s.genStatus.get();
  s.genStatus.set('cancelling');
  try {
    const outcome = await cancelGenerate(gameId);
    if (outcome === 'idle') {
      // Backend has no active run — the UI was stuck; reset to reality.
      s.genStatus.set('idle');
      s.genProgress.set(null);
    }
    // 'accepted': stay in 'cancelling' until generate_status:cancelled lands.
  } catch {
    s.genStatus.set(prev); // POST failed; the run is still going
  }
}

/** Header/active-run single-select (RunSelector, "single" mode) — drives Math
 * Profile via `selectedRun()` (state.ts). Delegates to the pure `selectRun`
 * reducer (mirrors `scrub`/`scrubTo` below) so the transition has reducer-level
 * test coverage instead of only an end-to-end one. */
export function selectRun(runId: string): void {
  const s = mathSlice();
  s.set(selectRunReducer(s.get({ noproxy: true }) as IMathState, runId) as never);
}

/** Compare multi-select toggle (RunSelector, "multi" mode) — see
 * `reducers.ts#toggleRunSelected` for the add/remove/cap behavior. */
export function toggleRunSelected(runId: string): void {
  const s = mathSlice();
  s.set(toggleRunSelectedReducer(s.get({ noproxy: true }) as IMathState, runId) as never);
}

/** Pin the Evolution scrubber to a specific generation (see `reducers.ts#scrubTo`).
 * `{ noproxy: true }` avoids feeding a tracking Proxy back into `.set()` — see the
 * detailed note in `socketClient.ts` on the same read-reduce-write shape. */
export function scrub(generation: number): void {
  const s = mathSlice();
  s.set(scrubTo(s.get({ noproxy: true }) as IMathState, generation) as never);
}

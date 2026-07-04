import { mathSlice, makeInitialState, type IMathState } from './state';
import { fetchRuns } from './restClient';
import { mathSock } from './socketClient';
import { scrubTo, selectRun as selectRunReducer, toggleRunSelected as toggleRunSelectedReducer } from './reducers';

/** Connects the lazily-created analytics socket (mirrors `initTuner`). Joining/
 * leaving the per-game room happens in `openGameMath`/`closeGameMath`
 * below, once a game is actually open. */
export function initMath(): void {
  mathSock().connect();
}

export async function openGameMath(gameId: string): Promise<void> {
  const s = mathSlice();
  s.activeGameId.set(gameId);
  s.loadStatus.set('loading');
  mathSock().joinMath(gameId);
  try {
    // `runsLoaded` (reducers.ts) expresses this same transition as a pure
    // function over `IMathState`, tested independently — applying it here
    // would need `s.get()` (hookstate's read-only `ImmutableObject<T>`), so the
    // state mutation is done directly against the slice instead.
    const runs = await fetchRuns(gameId);
    s.runs.set(runs as never);
    s.selectedRunId.set(runs[0]?.id ?? null);
    s.loadStatus.set('idle');
  } catch {
    s.loadStatus.set('error');
  }
}

export function closeGameMath(): void {
  const prev = mathSlice().activeGameId.get();
  if (prev) mathSock().leaveMath(prev);
  mathSlice().set(makeInitialState());
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

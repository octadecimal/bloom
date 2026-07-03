import { analyticsSlice, makeInitialState, type IAnalyticsState } from './state';
import { fetchRuns } from './restClient';
import { analyticsSock } from './socketClient';
import { scrubTo } from './reducers';

/** Connects the lazily-created analytics socket (mirrors `initTuner`). Joining/
 * leaving the per-game room happens in `openGameAnalytics`/`closeGameAnalytics`
 * below, once a game is actually open. */
export function initAnalytics(): void {
  analyticsSock().connect();
}

export async function openGameAnalytics(gameId: string): Promise<void> {
  const s = analyticsSlice();
  s.activeGameId.set(gameId);
  s.loadStatus.set('loading');
  analyticsSock().joinAnalytics(gameId);
  try {
    // `runsLoaded` (reducers.ts) expresses this same transition as a pure
    // function over `IAnalyticsState`, tested independently — applying it here
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

export function closeGameAnalytics(): void {
  const prev = analyticsSlice().activeGameId.get();
  if (prev) analyticsSock().leaveAnalytics(prev);
  analyticsSlice().set(makeInitialState());
}

export function selectRun(runId: string): void {
  analyticsSlice().selectedRunId.set(runId);
}

/** Pin the Evolution scrubber to a specific generation (see `reducers.ts#scrubTo`).
 * `{ noproxy: true }` avoids feeding a tracking Proxy back into `.set()` — see the
 * detailed note in `socketClient.ts` on the same read-reduce-write shape. */
export function scrub(generation: number): void {
  const s = analyticsSlice();
  s.set(scrubTo(s.get({ noproxy: true }) as IAnalyticsState, generation) as never);
}

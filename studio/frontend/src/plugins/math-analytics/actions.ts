import { analyticsSlice, makeInitialState } from './state';
import { fetchRuns } from './restClient';

/** No live socket in this slice (post-hoc, REST-only) — reserved for the Phase 2
 * live-progress relay (`analytics_progress` / `run_complete`), see
 * docs/superpowers/plans/2026-07-02-math-analytics-dashboard.md Task 12/13. */
export function initAnalytics(): void {}

export async function openGameAnalytics(gameId: string): Promise<void> {
  const s = analyticsSlice();
  s.activeGameId.set(gameId);
  s.loadStatus.set('loading');
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
  analyticsSlice().set(makeInitialState());
}

export function selectRun(runId: string): void {
  analyticsSlice().selectedRunId.set(runId);
}

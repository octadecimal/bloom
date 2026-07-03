import type { IAnalyticsState, IMathRun } from './state';

/** Store one run (e.g. a `run_complete` live event), selecting it if nothing is selected yet. */
export function runLoaded(state: IAnalyticsState, run: IMathRun): IAnalyticsState {
  const runs = [run, ...state.runs.filter((r) => r.id !== run.id)];
  return { ...state, runs, selectedRunId: state.selectedRunId ?? run.id };
}

/** Replace the run history (e.g. after `GET /analytics/runs`), selecting the newest run. */
export function runsLoaded(state: IAnalyticsState, runs: IMathRun[]): IAnalyticsState {
  return { ...state, runs, selectedRunId: runs[0]?.id ?? null };
}

import { MAX_COMPARE_SELECTION, type IAnalyticsState, type IGenFrame, type IMathRun } from './state';

/** Derives per-generation Evolution frames from a persisted run's trace —
 * exported for reuse by ReportTab (Task 17), which stacks the GA-evolution and
 * gene-convergence charts for a run's history post-hoc, the same way `runLoaded`
 * does when a run freezes. */
export function framesFromTrace(run: IMathRun): IGenFrame[] {
  return run.trace.map((t) => ({
    generation: t.generation,
    best: { fitness: t.bestFitness, rtp: t.bestRtp, volatility: t.bestVolatility },
    population: t.population,
    geneAgreement: t.geneAgreement,
  }));
}

/** Store one run (e.g. a `run_complete` live event), selecting it if nothing is
 * selected yet. Also freezes the Evolution tab: the persisted `trace` replaces
 * whatever ephemeral `analytics_progress` frames streamed in during the tune
 * (the doc is the post-hoc source of truth — live frames are never persisted),
 * and the playhead is pinned to the final generation instead of `'live'`. */
export function runLoaded(state: IAnalyticsState, run: IMathRun): IAnalyticsState {
  const runs = [run, ...state.runs.filter((r) => r.id !== run.id)];
  const frames = framesFromTrace(run);
  const lastGeneration = frames.length > 0 ? frames[frames.length - 1].generation : null;
  return {
    ...state,
    runs,
    selectedRunId: state.selectedRunId ?? run.id,
    frames: frames.length > 0 ? frames : state.frames,
    selectedGeneration: lastGeneration ?? state.selectedGeneration,
  };
}

/** Replace the run history (e.g. after `GET /analytics/runs`), selecting the newest run. */
export function runsLoaded(state: IAnalyticsState, runs: IMathRun[]): IAnalyticsState {
  return { ...state, runs, selectedRunId: runs[0]?.id ?? null };
}

/** Append one live per-generation frame (`analytics_progress`), replacing any
 * existing frame for the same generation (defends against a redelivered/duplicate
 * socket event) and keeping frames generation-ordered. A `'live'` playhead needs
 * no extra bookkeeping to "follow" the newest frame — `currentFrame` (state.ts)
 * resolves `'live'` dynamically — and a pinned (scrubbed) numeric playhead is left
 * untouched so a user inspecting an earlier generation isn't yanked to the edge. */
export function progressFrame(state: IAnalyticsState, frame: IGenFrame): IAnalyticsState {
  const frames = [...state.frames.filter((f) => f.generation !== frame.generation), frame].sort((a, b) => a.generation - b.generation);
  return { ...state, frames };
}

/** Pin the Evolution scrubber to a specific generation, leaving `'live'` mode. */
export function scrubTo(state: IAnalyticsState, generation: number): IAnalyticsState {
  return { ...state, selectedGeneration: generation };
}

/** Task 15 brief's name for `runsLoaded` above — same transition ("store the
 * fetched history list, newest-first"), re-exported under the requested name
 * rather than duplicated. See task-15-report.md. */
export const historyLoaded = runsLoaded;

/** Multi-select toggle for the Compare tab's `selectedRunIds` (RunSelector,
 * "multi" mode). Toggling an already-selected id removes it (selection order
 * of the remaining ids is preserved). Toggling a new id appends it — unless the
 * cap is already reached, in which case the toggle is a no-op: the new id is
 * neither added nor does it evict an existing selection (a user hits the cap by
 * deselecting one of the current five first). */
export function toggleRunSelected(state: IAnalyticsState, runId: string): IAnalyticsState {
  const selected = state.selectedRunIds;
  if (selected.includes(runId)) {
    return { ...state, selectedRunIds: selected.filter((id) => id !== runId) };
  }
  if (selected.length >= MAX_COMPARE_SELECTION) return state;
  return { ...state, selectedRunIds: [...selected, runId] };
}

/** Single-select for the header/active-run selector (RunSelector, "single"
 * mode) — replaces `selectedRunId` outright, same field the Math Profile tab
 * already reads via `selectedRun()` (state.ts). Wholly independent of
 * `selectedRunIds` (Compare's multi-select, above). */
export function selectRun(state: IAnalyticsState, runId: string): IAnalyticsState {
  return { ...state, selectedRunId: runId };
}

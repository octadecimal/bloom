import type { IAnalyticsState, IGenFrame, IMathRun } from './state';

function framesFromTrace(run: IMathRun): IGenFrame[] {
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

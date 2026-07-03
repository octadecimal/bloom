import type { State } from '@hookstate/core';
import { rootStore } from '../../state/rootStore';
import { makePluginHooks } from '../../state/makePluginHooks';

export const MATH_ANALYTICS_PLUGIN_ID = 'math-analytics';

// Wire types below mirror `MathRunDoc` (studio/backend/app/analytics/models.py) —
// camelCase, produced by `math_run_wire()`. Kept in lockstep with
// studio/backend/app/tuner/models.py's *Wire models (source of the `RunProfileWire`
// nested shapes) — see docs/superpowers/plans/2026-07-02-math-analytics-dashboard.md.

export interface ITuneWeights {
  rtp: number;
  volatility: number;
  hitRate: number;
}

export interface ITuningParams {
  masterSeed: number;
  population: number;
  maxGenerations: number;
  searchCandidateCount: number;
  finalCandidateCount: number;
  elitism: number;
  mutationRate: number;
  crossoverRate: number;
  stagnationWindow: number;
  weights: ITuneWeights;
}

export interface IMetrics {
  rtp: number;
  volatility: number;
  hitFrequency: number;
  baseRtp: number;
  featureRtp: number;
  bonusHitRates: number[];
}

export interface IPopulationStats {
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  mean: number;
  diversity: number;
}

export interface IGenSnapshot {
  generation: number;
  bestFitness: number;
  bestRtp: number;
  bestVolatility: number;
  population: IPopulationStats;
  geneAgreement: number[];
}

/** One live (or replayed post-hoc) per-generation frame — the shape carried by
 * the `analytics_progress` socket event and, post-hoc, derived from `IMathRun.trace`
 * (see `reducers.ts#progressFrame` / `runLoaded`). Mirrors `IGenSnapshot` minus the
 * `generation` duplication, grouping the scalar "best" trio together for the
 * Evolution tab's charts. */
export interface IGenFrame {
  generation: number;
  best: { fitness: number; rtp: number; volatility: number };
  population: IPopulationStats;
  geneAgreement: number[];
}

export interface IHistogramBin {
  binLo: number;
  // The open-ended top bin's binHi is `null` on the wire (Rust's f64::INFINITY
  // isn't JSON-safe) — render it as e.g. "…×+".
  binHi: number | null;
  base: number;
  feature: number;
}

export interface IWinDistribution {
  bins: IHistogramBin[];
  zeroCount: number;
}

export interface ITailMetrics {
  maxWin: number;
  pGE100x: number;
  pLosingSpin: number;
  longestDeadStreak: number;
  bonusTriggerRate: number;
}

export interface IRtpPoint {
  n: number;
  realizedRtp: number;
}

export interface IRunProfile {
  distribution: IWinDistribution;
  tail: ITailMetrics;
  rtpConvergence: IRtpPoint[];
}

export interface IMathRun {
  id: string;
  gameId: string;
  params: ITuningParams;
  verdict: 'pass' | 'near_miss' | null;
  metrics: IMetrics | null;
  trace: IGenSnapshot[];
  profile: IRunProfile | null;
  createdAt: string;
  durationMs: number | null;
}

export interface IAnalyticsState {
  activeGameId: string | null;
  runs: IMathRun[];
  selectedRunId: string | null;
  loadStatus: 'idle' | 'loading' | 'error';
  /** Per-generation Evolution frames — live-appended from `analytics_progress`
   * while a tune runs, or replayed wholesale from `IMathRun.trace` once a run
   * freezes (`reducers.ts#runLoaded`). Always generation-ordered. */
  frames: IGenFrame[];
  /** The Evolution scrubber's playhead. `'live'` tracks the newest frame as it
   * arrives; scrubbing pins it to a specific generation (see `reducers.ts#scrubTo`). */
  selectedGeneration: number | 'live';
}

export function makeInitialState(): IAnalyticsState {
  return {
    activeGameId: null,
    runs: [],
    selectedRunId: null,
    loadStatus: 'idle',
    frames: [],
    selectedGeneration: 'live',
  };
}

export const analyticsHooks = makePluginHooks<IAnalyticsState>(MATH_ANALYTICS_PLUGIN_ID);

export function analyticsSlice(): State<IAnalyticsState> {
  return rootStore.plugins.nested(MATH_ANALYTICS_PLUGIN_ID) as unknown as State<IAnalyticsState>;
}

export function selectedRun(state: IAnalyticsState): IMathRun | null {
  if (state.selectedRunId) {
    const found = state.runs.find((r) => r.id === state.selectedRunId);
    if (found) return found;
  }
  return state.runs[0] ?? null;
}

/** The frame the Evolution charts' playhead points at: the newest frame in
 * `'live'` mode, or the frame matching a scrubbed generation (falling back to
 * the newest frame if the exact generation isn't present). */
export function currentFrame(state: Pick<IAnalyticsState, 'frames' | 'selectedGeneration'>): IGenFrame | null {
  if (state.frames.length === 0) return null;
  if (state.selectedGeneration === 'live') return state.frames[state.frames.length - 1];
  return state.frames.find((f) => f.generation === state.selectedGeneration) ?? state.frames[state.frames.length - 1];
}

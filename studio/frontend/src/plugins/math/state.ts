import type { State } from '@hookstate/core';
import { rootStore } from '../../state/rootStore';
import { makePluginHooks } from '../../state/makePluginHooks';

export const MATH_PLUGIN_ID = 'math';

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

export interface ISectionLocks {
  reels: boolean;
  paytable: boolean;
  bonus: boolean;
}

export interface ICurationParams {
  poolSize: number;
  candidateCount: number;
  masterSeed: number;
  rtpTolerance: number;
  realizedCorrectionBand: number;
  bonusRateTolerance: number;
}

export interface ICurationResult {
  status: 'pass' | 'fail' | 'error';
  metrics: IMetrics;
  realizedRtp: number | null;
  poolSize: number | null;
  failure: string | null;
  ranAt: string;
}

export interface IBandMiss {
  metric: string;
  measured: number;
  bandLo: number;
  bandHi: number;
}

export interface ITuneResult {
  status: 'pass' | 'near_miss' | 'error';
  verdict: 'pass' | 'near_miss' | null;
  tunedModel: unknown | null;
  metrics: IMetrics | null;
  missed: IBandMiss[];
  failure: string | null;
  ranAt: string;
}

/** Snake_case on the wire — `derive_target` returns a plain dict (no camel aliasing). */
export interface ITargetSpec {
  rtp_target: number;
  rtp_tolerance: number;
  volatility_min: number;
  volatility_max: number;
  bonus_hit_rate_bands: { min: number; max: number }[];
}

/** Raw editable strings mirrored from the GDD math-model `data` dict. */
export interface ITargetFields {
  rtp: string;
  volatility: string;
  bonusHitRate: string;
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
  verify: ICurationResult | null;
  locks: ISectionLocks | null;
}

export interface IMathState {
  activeGameId: string | null;
  runs: IMathRun[];
  selectedRunId: string | null;
  /** Multi-select for the Compare tab (Task 16) — up to `MAX_COMPARE_SELECTION`
   * run ids, kept in *selection order* (not history order): position `i` drives
   * that run's chip/series color via `chartSeriesToken(i)` (see below). Wholly
   * independent of `selectedRunId`, the header/active-run single-select that
   * already drives Math Profile — a run can be Compare-selected without being
   * the active one, and vice versa. */
  selectedRunIds: string[];
  loadStatus: 'idle' | 'loading' | 'error';
  /** Per-generation Evolution frames — live-appended from `analytics_progress`
   * while a tune runs, or replayed wholesale from `IMathRun.trace` once a run
   * freezes (`reducers.ts#runLoaded`). Always generation-ordered. */
  frames: IGenFrame[];
  /** The Evolution scrubber's playhead. `'live'` tracks the newest frame as it
   * arrives; scrubbing pins it to a specific generation (see `reducers.ts#scrubTo`). */
  selectedGeneration: number | 'live';
  // target strip
  targetFields: ITargetFields | null;
  gddWatermark: string;
  derivedTarget: ITargetSpec | null;
  targetGap: string | null;
  targetSaveStatus: 'idle' | 'saving' | 'saved' | 'error';
  // generate pipeline
  genStatus: 'idle' | 'tuning' | 'verifying' | 'done' | 'failed';
  genProgress: { generation: number; maxGenerations: number } | null;
  genFailure: string | null;
  // verify-only (curation of the stored model)
  verifyStatus: 'idle' | 'running' | 'pass' | 'fail' | 'error';
  verifyProgress: { phase: string; done: number | null; total: number | null } | null;
  verifyResult: ICurationResult | null;
  verifyFailure: string | null;
  // apply
  tuneResult: ITuneResult | null;
  applied: boolean;
  // doc-derived
  locks: ISectionLocks | null;
  tunerParams: ITuningParams | null;
  curationParams: ICurationParams | null;
}

export function makeInitialState(): IMathState {
  return {
    activeGameId: null,
    runs: [],
    selectedRunId: null,
    selectedRunIds: [],
    loadStatus: 'idle',
    frames: [],
    selectedGeneration: 'live',
    targetFields: null,
    gddWatermark: '',
    derivedTarget: null,
    targetGap: null,
    targetSaveStatus: 'idle',
    genStatus: 'idle',
    genProgress: null,
    genFailure: null,
    verifyStatus: 'idle',
    verifyProgress: null,
    verifyResult: null,
    verifyFailure: null,
    tuneResult: null,
    applied: false,
    locks: null,
    tunerParams: null,
    curationParams: null,
  };
}

/** Compare's multi-select cap (`reducers.ts#toggleRunSelected`) — also the
 * number of distinct chart-identity colors below, so every selectable run
 * always gets its own color. */
export const MAX_COMPARE_SELECTION = 5;

// One `--chart-series-N` CSS var per Compare selection slot (styles.css). A
// first-pass categorical palette spread across hue, avoiding the reserved
// red/orange/amber band (--accent, --warning, --chart-tail all live there) and
// staying clear of --chart-base/--chart-feature's blue/green. Good enough for
// the RunSelector's chip swatches; if Task 16's actual overlay lines expose
// perceptual collisions, re-validate via the dataviz skill's
// scripts/validate_palette.js and adjust here (the seam is this one array).
const CHART_SERIES_TOKENS = ['--chart-series-1', '--chart-series-2', '--chart-series-3', '--chart-series-4', '--chart-series-5'] as const;

/** The CSS custom-property name for a Compare selection's color identity, by
 * position in `selectedRunIds` (0-indexed). Cycles defensively past the palette
 * length, though callers should never exceed `MAX_COMPARE_SELECTION`. */
export function chartSeriesToken(index: number): string {
  return CHART_SERIES_TOKENS[index % CHART_SERIES_TOKENS.length];
}

/** Human-readable identity for a Compare selection slot, by position in
 * `selectedRunIds` — shared by the overlay charts' series legends
 * (`OverlayLines.tsx`) and the delta table's column headers (`DeltaTable.tsx`)
 * so the same run reads with the same label everywhere in the Compare tab
 * (Task 16). */
export function runSeriesLabel(run: IMathRun, index: number): string {
  return `Run ${index + 1} · ${new Date(run.createdAt).toLocaleString()}`;
}

export const mathHooks = makePluginHooks<IMathState>(MATH_PLUGIN_ID);

export function mathSlice(): State<IMathState> {
  return rootStore.plugins.nested(MATH_PLUGIN_ID) as unknown as State<IMathState>;
}

export function selectedRun(state: IMathState): IMathRun | null {
  if (state.selectedRunId) {
    const found = state.runs.find((r) => r.id === state.selectedRunId);
    if (found) return found;
  }
  return state.runs[0] ?? null;
}

/** The frame the Evolution charts' playhead points at: the newest frame in
 * `'live'` mode, or the frame matching a scrubbed generation (falling back to
 * the newest frame if the exact generation isn't present). */
export function currentFrame(state: Pick<IMathState, 'frames' | 'selectedGeneration'>): IGenFrame | null {
  if (state.frames.length === 0) return null;
  if (state.selectedGeneration === 'live') return state.frames[state.frames.length - 1];
  return state.frames.find((f) => f.generation === state.selectedGeneration) ?? state.frames[state.frames.length - 1];
}

import type { State } from '@hookstate/core';
import type { IMathState } from '../state';

export type IParamGroup = 'tuner' | 'weights' | 'curation';

export interface IParamTooltip {
  title: string;
  /** 1–2 sentences: what the field IS. */
  body: string;
  /** One line: the practical effect of raising/lowering it. */
  effect: string;
}

export interface IParamFieldDef {
  /** Stable id — also the testid suffix (`param-<key>`). 'master-seed' and
   * 'pool-size' keep the legacy testids alive. */
  key: string;
  label: string;
  group: IParamGroup;
  tooltip: IParamTooltip;
  /** Faint in-field suffix (counts only; fractions are explained in the tooltip). */
  unit?: string;
  min?: number;
  max?: number;
  step: number;
  integer: boolean;
  /** Mirrors default_tuning_params() / default_params() in
   * studio/backend/app/math/models.py — keep in lockstep. */
  defaultValue: number;
  get: (s: State<IMathState>) => number | null;
  set: (s: State<IMathState>, v: number) => void;
}

export const PARAM_GROUPS: { id: IParamGroup; label: string }[] = [
  { id: 'tuner', label: 'Tuner' },
  { id: 'weights', label: 'Fitness weights' },
  { id: 'curation', label: 'Curation' },
];

export const PARAM_FIELDS: IParamFieldDef[] = [
  // ── tuner ──────────────────────────────────────────────────────────────
  {
    key: 'master-seed',
    label: 'Seed',
    group: 'tuner',
    tooltip: {
      title: 'Master seed',
      body: "Seeds the genetic algorithm's random number generator.",
      effect: 'Same seed + same params → an identical, reproducible run.',
    },
    min: 0,
    step: 1,
    integer: true,
    defaultValue: 2026,
    get: (s) => s.tunerParams.ornull?.masterSeed.get() ?? null,
    set: (s, v) => s.tunerParams.ornull?.masterSeed.set(v),
  },
  {
    key: 'population',
    label: 'Population',
    group: 'tuner',
    tooltip: {
      title: 'Population',
      body: 'Number of candidate models alive in each GA generation.',
      effect: 'Higher = broader search per generation, but slower.',
    },
    min: 2,
    step: 1,
    integer: true,
    defaultValue: 24,
    get: (s) => s.tunerParams.ornull?.population.get() ?? null,
    set: (s, v) => s.tunerParams.ornull?.population.set(v),
  },
  {
    key: 'generations',
    label: 'Generations',
    group: 'tuner',
    tooltip: {
      title: 'Max generations',
      body: 'Upper budget on GA generations; the run stops earlier once the target is feasible or progress stagnates.',
      effect: 'Higher = more time to converge on hard targets.',
    },
    min: 1,
    step: 1,
    integer: true,
    defaultValue: 40,
    get: (s) => s.tunerParams.ornull?.maxGenerations.get() ?? null,
    set: (s, v) => s.tunerParams.ornull?.maxGenerations.set(v),
  },
  {
    key: 'search-spins',
    label: 'Search spins',
    group: 'tuner',
    tooltip: {
      title: 'Search spins',
      body: 'Spins simulated to measure each candidate during the search phase (low fidelity).',
      effect: 'Higher = less measurement noise, slower generations.',
    },
    unit: 'spins',
    min: 1000,
    step: 1000,
    integer: true,
    defaultValue: 20000,
    get: (s) => s.tunerParams.ornull?.searchCandidateCount.get() ?? null,
    set: (s, v) => s.tunerParams.ornull?.searchCandidateCount.set(v),
  },
  {
    key: 'final-spins',
    label: 'Final spins',
    group: 'tuner',
    tooltip: {
      title: 'Final spins',
      body: 'Spins for the trusted final-fidelity confirmation of the best candidate; only these measurements decide the verdict.',
      effect: 'Higher = tighter confidence in the reported metrics.',
    },
    unit: 'spins',
    min: 10000,
    step: 10000,
    integer: true,
    defaultValue: 200000,
    get: (s) => s.tunerParams.ornull?.finalCandidateCount.get() ?? null,
    set: (s, v) => s.tunerParams.ornull?.finalCandidateCount.set(v),
  },
  {
    key: 'elitism',
    label: 'Elitism',
    group: 'tuner',
    tooltip: {
      title: 'Elitism',
      body: 'Best candidates copied unchanged into the next generation.',
      effect: 'Guards against losing the best solution to mutation.',
    },
    min: 0,
    step: 1,
    integer: true,
    defaultValue: 2,
    get: (s) => s.tunerParams.ornull?.elitism.get() ?? null,
    set: (s, v) => s.tunerParams.ornull?.elitism.set(v),
  },
  {
    key: 'mutation',
    label: 'Mutation',
    group: 'tuner',
    tooltip: {
      title: 'Mutation rate',
      body: 'Chance each gene mutates while breeding the next generation (0–1).',
      effect: 'Higher = more exploration, less stability.',
    },
    min: 0,
    max: 1,
    step: 0.05,
    integer: false,
    defaultValue: 0.25,
    get: (s) => s.tunerParams.ornull?.mutationRate.get() ?? null,
    set: (s, v) => s.tunerParams.ornull?.mutationRate.set(v),
  },
  {
    key: 'crossover',
    label: 'Crossover',
    group: 'tuner',
    tooltip: {
      title: 'Crossover rate',
      body: 'Chance two parents mix genes instead of cloning (0–1).',
      effect: 'Higher = more recombination of good traits.',
    },
    min: 0,
    max: 1,
    step: 0.05,
    integer: false,
    defaultValue: 0.9,
    get: (s) => s.tunerParams.ornull?.crossoverRate.get() ?? null,
    set: (s, v) => s.tunerParams.ornull?.crossoverRate.set(v),
  },
  {
    key: 'stagnation',
    label: 'Stagnation',
    group: 'tuner',
    tooltip: {
      title: 'Stagnation window',
      body: 'Generations without improvement before the GA stops early.',
      effect: 'Lower = give up sooner on a stuck search.',
    },
    unit: 'gens',
    min: 1,
    step: 1,
    integer: true,
    defaultValue: 12,
    get: (s) => s.tunerParams.ornull?.stagnationWindow.get() ?? null,
    set: (s, v) => s.tunerParams.ornull?.stagnationWindow.set(v),
  },
  // ── fitness weights ────────────────────────────────────────────────────
  {
    key: 'weight-rtp',
    label: 'RTP',
    group: 'weights',
    tooltip: {
      title: 'RTP weight',
      body: 'Relative importance of RTP error in the fitness score.',
      effect: 'Higher = the GA prioritizes matching RTP.',
    },
    min: 0,
    step: 0.1,
    integer: false,
    defaultValue: 1.0,
    get: (s) => s.tunerParams.ornull?.weights.rtp.get() ?? null,
    set: (s, v) => s.tunerParams.ornull?.weights.rtp.set(v),
  },
  {
    key: 'weight-volatility',
    label: 'Volatility',
    group: 'weights',
    tooltip: {
      title: 'Volatility weight',
      body: 'Relative importance of volatility error in the fitness score.',
      effect: 'Higher = the GA prioritizes matching volatility.',
    },
    min: 0,
    step: 0.1,
    integer: false,
    defaultValue: 1.0,
    get: (s) => s.tunerParams.ornull?.weights.volatility.get() ?? null,
    set: (s, v) => s.tunerParams.ornull?.weights.volatility.set(v),
  },
  {
    key: 'weight-hit-rate',
    label: 'Hit rate',
    group: 'weights',
    tooltip: {
      title: 'Hit-rate weight',
      body: 'Relative importance of bonus hit-rate error in the fitness score.',
      effect: 'Higher = the GA prioritizes matching bonus hit rates.',
    },
    min: 0,
    step: 0.1,
    integer: false,
    defaultValue: 1.0,
    get: (s) => s.tunerParams.ornull?.weights.hitRate.get() ?? null,
    set: (s, v) => s.tunerParams.ornull?.weights.hitRate.set(v),
  },
  // ── curation ───────────────────────────────────────────────────────────
  {
    key: 'pool-size',
    label: 'Pool size',
    group: 'curation',
    tooltip: {
      title: 'Pool size',
      body: 'Outcomes frozen into the signed pool the game server draws from.',
      effect: "Larger pools track the model's RTP more faithfully.",
    },
    unit: 'outcomes',
    min: 100,
    step: 100,
    integer: true,
    defaultValue: 1000,
    get: (s) => s.curationParams.ornull?.poolSize.get() ?? null,
    set: (s, v) => s.curationParams.ornull?.poolSize.set(v),
  },
  {
    key: 'candidates',
    label: 'Candidates',
    group: 'curation',
    tooltip: {
      title: 'Candidates',
      body: 'Spins simulated to measure the model during verification.',
      effect: 'Higher = less measurement noise, slower verify.',
    },
    unit: 'spins',
    min: 1000,
    step: 1000,
    integer: true,
    defaultValue: 50000,
    get: (s) => s.curationParams.ornull?.candidateCount.get() ?? null,
    set: (s, v) => s.curationParams.ornull?.candidateCount.set(v),
  },
  {
    key: 'sim-seed',
    label: 'Sim seed',
    group: 'curation',
    tooltip: {
      title: 'Sim seed',
      body: "Seeds the verification simulation's random number generator.",
      effect: 'Same seed + same model → identical verification.',
    },
    min: 0,
    step: 1,
    integer: true,
    defaultValue: 2026,
    get: (s) => s.curationParams.ornull?.masterSeed.get() ?? null,
    set: (s, v) => s.curationParams.ornull?.masterSeed.set(v),
  },
  {
    key: 'rtp-tolerance',
    label: 'RTP tolerance',
    group: 'curation',
    tooltip: {
      title: 'RTP tolerance',
      body: 'Allowed absolute deviation of measured RTP from the target (0.01 = ±1%).',
      effect: 'Tighter = stricter pass, more verify failures.',
    },
    min: 0.001,
    step: 0.005,
    integer: false,
    defaultValue: 0.01,
    get: (s) => s.curationParams.ornull?.rtpTolerance.get() ?? null,
    set: (s, v) => s.curationParams.ornull?.rtpTolerance.set(v),
  },
  {
    key: 'correction-band',
    label: 'Correction band',
    group: 'curation',
    tooltip: {
      title: 'Correction band',
      body: "Honesty guardrail: curation may only correct the pool toward a target within this band of the model's measured RTP.",
      effect: 'Outside the band, curation fails instead of lying.',
    },
    min: 0.001,
    step: 0.01,
    integer: false,
    defaultValue: 0.05,
    get: (s) => s.curationParams.ornull?.realizedCorrectionBand.get() ?? null,
    set: (s, v) => s.curationParams.ornull?.realizedCorrectionBand.set(v),
  },
  {
    key: 'bonus-tolerance',
    label: 'Bonus tolerance',
    group: 'curation',
    tooltip: {
      title: 'Bonus tolerance',
      body: 'Relative ± band around the GDD bonus hit rate during verification.',
      effect: 'Tighter = bonus rates must match the design more exactly.',
    },
    min: 0.01,
    step: 0.05,
    integer: false,
    defaultValue: 0.25,
    get: (s) => s.curationParams.ornull?.bonusRateTolerance.get() ?? null,
    set: (s, v) => s.curationParams.ornull?.bonusRateTolerance.set(v),
  },
];

/** Write a group's backend defaults into the slice; a no-op while that group's
 * params haven't loaded (accessors guard with `ornull`). */
export function resetGroup(s: State<IMathState>, group: IParamGroup): void {
  for (const f of PARAM_FIELDS) if (f.group === group) f.set(s, f.defaultValue);
}

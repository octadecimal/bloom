import { describe, it, expect } from 'vitest';
import {
  runLoaded,
  runsLoaded,
  historyLoaded,
  toggleRunSelected,
  selectRun,
  progressFrame,
  scrubTo,
  latestOutcome,
  outcomeVerdict,
  allLocked,
  worstMiss,
} from './reducers';
import { makeInitialState, currentFrame, MAX_COMPARE_SELECTION } from './state';
import type { IMathRun, IGenFrame, IGenSnapshot, ICurationResult, IMetrics, ITargetSpec } from './state';

function run(id: string, trace: IGenSnapshot[] = []): IMathRun {
  return {
    id,
    gameId: 'g1',
    params: {} as never,
    verdict: 'pass',
    metrics: null,
    trace,
    profile: null,
    createdAt: 't',
    durationMs: null,
    verify: null,
    locks: null,
  };
}

function snapshot(generation: number): IGenSnapshot {
  return {
    generation,
    bestFitness: -0.1 * generation,
    bestRtp: 0.9 + generation * 0.001,
    bestVolatility: 2 + generation * 0.01,
    population: { min: 0.1, q1: 0.2, median: 0.3, q3: 0.4, max: 0.5, mean: 0.3, diversity: 0.5 - generation * 0.01 },
    geneAgreement: [0.1 + generation * 0.01, 0.2 + generation * 0.01],
  };
}

function frame(generation: number): IGenFrame {
  return {
    generation,
    best: { fitness: -0.1 * generation, rtp: 0.9 + generation * 0.001, volatility: 2 + generation * 0.01 },
    population: { min: 0.1, q1: 0.2, median: 0.3, q3: 0.4, max: 0.5, mean: 0.3, diversity: 0.5 - generation * 0.01 },
    geneAgreement: [0.1 + generation * 0.01, 0.2 + generation * 0.01],
  };
}

describe('runLoaded', () => {
  it('stores an IMathRun and selects it when nothing was selected', () => {
    const next = runLoaded(makeInitialState(), run('r1'));
    expect(next.runs).toEqual([run('r1')]);
    expect(next.selectedRunId).toBe('r1');
  });

  it('replaces an existing run with the same id instead of duplicating it', () => {
    const state = runLoaded(makeInitialState(), run('r1'));
    const next = runLoaded(state, { ...run('r1'), verdict: 'near_miss' });
    expect(next.runs).toHaveLength(1);
    expect(next.runs[0].verdict).toBe('near_miss');
  });

  it('does not steal the selection from an already-selected run', () => {
    const state = { ...makeInitialState(), selectedRunId: 'r1', runs: [run('r1')] };
    const next = runLoaded(state, run('r2'));
    expect(next.selectedRunId).toBe('r1');
  });

  it('freezes the playhead to the last generation and replays frames from the trace', () => {
    const trace = [snapshot(0), snapshot(1), snapshot(2)];
    const next = runLoaded(makeInitialState(), run('r1', trace));
    expect(next.frames).toHaveLength(3);
    expect(next.frames.map((f) => f.generation)).toEqual([0, 1, 2]);
    expect(next.frames[2].best.rtp).toBeCloseTo(snapshot(2).bestRtp);
    expect(next.selectedGeneration).toBe(2); // frozen, not 'live'
  });

  it('replaces any live-streamed frames with the persisted trace (trace is the source of truth)', () => {
    let state = progressFrame(makeInitialState(), frame(0));
    state = progressFrame(state, frame(1));
    const next = runLoaded(state, run('r1', [snapshot(0), snapshot(1), snapshot(2)]));
    expect(next.frames).toHaveLength(3);
    expect(next.selectedGeneration).toBe(2);
  });

  it('leaves the playhead alone when the run has no trace', () => {
    const next = runLoaded(makeInitialState(), run('r1', []));
    expect(next.frames).toEqual([]);
    expect(next.selectedGeneration).toBe('live');
  });
});

describe('progressFrame', () => {
  it('appends a live frame', () => {
    const next = progressFrame(makeInitialState(), frame(0));
    expect(next.frames).toEqual([frame(0)]);
  });

  it('advances the live playhead to the newest frame as frames arrive', () => {
    let state = makeInitialState();
    state = progressFrame(state, frame(0));
    expect(currentFrame(state)?.generation).toBe(0);
    state = progressFrame(state, frame(1));
    expect(currentFrame(state)?.generation).toBe(1);
    state = progressFrame(state, frame(2));
    expect(currentFrame(state)?.generation).toBe(2);
  });

  it('does not move a pinned (scrubbed) playhead when a new frame arrives', () => {
    let state = progressFrame(makeInitialState(), frame(0));
    state = progressFrame(state, frame(1));
    state = scrubTo(state, 0);
    state = progressFrame(state, frame(2));
    expect(state.selectedGeneration).toBe(0);
    expect(currentFrame(state)?.generation).toBe(0);
  });

  it('replaces a duplicate generation instead of appending twice', () => {
    let state = progressFrame(makeInitialState(), frame(0));
    state = progressFrame(state, { ...frame(0), best: { fitness: -9, rtp: 0.5, volatility: 1 } });
    expect(state.frames).toHaveLength(1);
    expect(state.frames[0].best.fitness).toBe(-9);
  });
});

describe('scrubTo', () => {
  it('pins the selected generation', () => {
    let state = progressFrame(makeInitialState(), frame(0));
    state = progressFrame(state, frame(1));
    state = scrubTo(state, 0);
    expect(state.selectedGeneration).toBe(0);
    expect(currentFrame(state)?.generation).toBe(0);
  });
});

describe('runsLoaded', () => {
  it('replaces the run history and selects the newest (first) run', () => {
    const next = runsLoaded(makeInitialState(), [run('r2'), run('r1')]);
    expect(next.runs.map((r) => r.id)).toEqual(['r2', 'r1']);
    expect(next.selectedRunId).toBe('r2');
  });

  it('selects null when the history is empty', () => {
    const next = runsLoaded(makeInitialState(), []);
    expect(next.selectedRunId).toBeNull();
  });
});

// `historyLoaded` is the Task 15 brief's name for this same transition — Task 10
// already shipped it as `runsLoaded` to back the Math Profile tab's active-run
// pointer. Re-exported under the requested name rather than duplicating the
// reducer (see task-15-report.md for the rationale).
describe('historyLoaded', () => {
  it('is runsLoaded — replaces the run history and selects the newest run', () => {
    const next = historyLoaded(makeInitialState(), [run('r2'), run('r1')]);
    expect(next.runs.map((r) => r.id)).toEqual(['r2', 'r1']);
    expect(next.selectedRunId).toBe('r2');
  });

  it('is the same function reference as runsLoaded', () => {
    expect(historyLoaded).toBe(runsLoaded);
  });
});

describe('toggleRunSelected', () => {
  it('adds an unselected run id to selectedRunIds', () => {
    const next = toggleRunSelected(makeInitialState(), 'r1');
    expect(next.selectedRunIds).toEqual(['r1']);
  });

  it('appends further ids in selection order', () => {
    let state = toggleRunSelected(makeInitialState(), 'r1');
    state = toggleRunSelected(state, 'r2');
    expect(state.selectedRunIds).toEqual(['r1', 'r2']);
  });

  it('removes an already-selected run id (toggle off)', () => {
    let state = toggleRunSelected(makeInitialState(), 'r1');
    state = toggleRunSelected(state, 'r2');
    state = toggleRunSelected(state, 'r1');
    expect(state.selectedRunIds).toEqual(['r2']);
  });

  it('does not add a run beyond MAX_COMPARE_SELECTION, and keeps the existing selection intact', () => {
    let state = { ...makeInitialState(), selectedRunIds: ['r1', 'r2', 'r3', 'r4', 'r5'] };
    expect(state.selectedRunIds).toHaveLength(MAX_COMPARE_SELECTION);
    const next = toggleRunSelected(state, 'r6');
    expect(next.selectedRunIds).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
  });

  it('still allows removing a selection while at the cap', () => {
    const state = { ...makeInitialState(), selectedRunIds: ['r1', 'r2', 'r3', 'r4', 'r5'] };
    const next = toggleRunSelected(state, 'r3');
    expect(next.selectedRunIds).toEqual(['r1', 'r2', 'r4', 'r5']);
  });

  it('does not mutate other state fields', () => {
    const state = { ...makeInitialState(), selectedRunId: 'r9', runs: [run('r9')] };
    const next = toggleRunSelected(state, 'r1');
    expect(next.selectedRunId).toBe('r9');
    expect(next.runs).toEqual([run('r9')]);
  });
});

describe('selectRun (reducer)', () => {
  it('single-selects the given run id, replacing any prior selection', () => {
    const state = { ...makeInitialState(), selectedRunId: 'r1' };
    const next = selectRun(state, 'r2');
    expect(next.selectedRunId).toBe('r2');
  });

  it('does not touch selectedRunIds (independent from Compare multi-select)', () => {
    const state = { ...makeInitialState(), selectedRunIds: ['r5'] };
    const next = selectRun(state, 'r2');
    expect(next.selectedRunIds).toEqual(['r5']);
  });
});

// Helpers for outcome reducer tests — complete IMathRun + ICurationResult literals.
function makeRun(overrides: Partial<IMathRun>): IMathRun {
  return {
    id: 'r1',
    gameId: 'g1',
    params: {} as never,
    verdict: 'pass',
    metrics: null,
    trace: [],
    profile: null,
    createdAt: '2026-07-04T10:00:00Z',
    durationMs: null,
    verify: null,
    locks: null,
    ...overrides,
  };
}

function makeCuration(overrides?: Partial<ICurationResult>): ICurationResult {
  return {
    status: 'pass',
    metrics: { rtp: 0, volatility: 0, hitFrequency: 0, baseRtp: 0, featureRtp: 0, bonusHitRates: [] },
    realizedRtp: null,
    poolSize: null,
    failure: null,
    ranAt: '2026-07-04T11:00:00Z',
    ...overrides,
  };
}

describe('latestOutcome', () => {
  it('returns null with no runs and no verify result', () => {
    expect(latestOutcome({ runs: [], verifyResult: null })).toBeNull();
  });
  it('prefers the newest of run vs verify-only result by timestamp', () => {
    const run = makeRun({ id: 'r1', createdAt: '2026-07-04T10:00:00Z' });
    const verify = makeCuration({ ranAt: '2026-07-04T11:00:00Z' });
    expect(latestOutcome({ runs: [run], verifyResult: verify })).toEqual({ kind: 'verify', result: verify });
    const older = makeCuration({ ranAt: '2026-07-04T09:00:00Z' });
    expect(latestOutcome({ runs: [run], verifyResult: older })).toEqual({ kind: 'run', run });
  });
});

describe('outcomeVerdict', () => {
  it('uses the independent verify verdict of a run when present, else the GA verdict', () => {
    const failedVerify = makeRun({ verdict: 'pass', verify: makeCuration({ status: 'fail' }) });
    expect(outcomeVerdict({ kind: 'run', run: failedVerify })).toBe('fail');
    const noVerify = makeRun({ verdict: 'near_miss', verify: null });
    expect(outcomeVerdict({ kind: 'run', run: noVerify })).toBe('near_miss');
  });
});

describe('allLocked', () => {
  it('is true only when all three sections are locked', () => {
    expect(allLocked({ reels: true, paytable: true, bonus: true })).toBe(true);
    expect(allLocked({ reels: true, paytable: true, bonus: false })).toBe(false);
    expect(allLocked(null)).toBe(false);
  });
});

describe('worstMiss', () => {
  const target: ITargetSpec = { rtp_target: 0.96, rtp_tolerance: 0.01, volatility_min: 3, volatility_max: 6, bonus_hit_rate_bands: [] };
  const metrics = (rtp: number, vol: number): IMetrics => ({ rtp, volatility: vol, hitFrequency: 0.3, baseRtp: rtp, featureRtp: 0, bonusHitRates: [] });

  it('returns null when every gate is in band', () => {
    expect(worstMiss(metrics(0.96, 4), target)).toBeNull();
  });

  it('reports the below-band rtp distance', () => {
    expect(worstMiss(metrics(0.9, 4), target)).toEqual({ metric: 'rtp', distance: expect.closeTo(0.05, 10), side: 'below' });
  });

  it('picks the RELATIVELY worse gate when several miss', () => {
    // rtp miss 0.05/0.02 = 2.5 band-widths; vol miss 1/3 band-widths → rtp wins.
    expect(worstMiss(metrics(0.9, 7), target)!.metric).toBe('rtp');
  });

  it('normalizes an open-ended volatility band by its finite edge', () => {
    const high = { ...target, volatility_min: 10, volatility_max: 1e9 };
    // vol 5 → miss 5, rel 5/10 = 0.5; rtp in band → vol is the (only) miss.
    expect(worstMiss(metrics(0.96, 5), high)).toEqual({ metric: 'volatility', distance: 5, side: 'below' });
  });

  it('reports an out-of-band hit frequency when the target carries the band', () => {
    const targetWithBand: ITargetSpec = {
      rtp_target: 0.96,
      rtp_tolerance: 0.1,
      volatility_min: 0,
      volatility_max: 1e9,
      bonus_hit_rate_bands: [],
      hit_frequency_band: { min: 0.3, max: 0.4 },
    };
    const m: IMetrics = { rtp: 0.96, volatility: 3, hitFrequency: 0.2, baseRtp: 0.96, featureRtp: 0, bonusHitRates: [] };
    expect(worstMiss(m, targetWithBand)).toEqual({ metric: 'hit_frequency', distance: expect.closeTo(0.1, 6), side: 'below' });
  });
});

import { describe, it, expect } from 'vitest';
import { runLoaded, runsLoaded, progressFrame, scrubTo } from './reducers';
import { makeInitialState, currentFrame } from './state';
import type { IMathRun, IGenFrame, IGenSnapshot } from './state';

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

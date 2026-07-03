import { describe, it, expect } from 'vitest';
import { runLoaded, runsLoaded } from './reducers';
import { makeInitialState } from './state';
import type { IMathRun } from './state';

function run(id: string): IMathRun {
  return {
    id,
    gameId: 'g1',
    params: {} as never,
    verdict: 'pass',
    metrics: null,
    trace: [],
    profile: null,
    createdAt: 't',
    durationMs: null,
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

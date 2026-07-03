import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { MATH_ANALYTICS_PLUGIN_ID, makeInitialState, analyticsSlice } from './state';
import type { IMathRun } from './state';

const fetchRuns = vi.fn();
vi.mock('./restClient', () => ({
  fetchRuns: (gameId: string, limit?: number) => fetchRuns(gameId, limit),
  fetchRun: vi.fn(),
}));

import { openGameAnalytics, closeGameAnalytics } from './actions';

function run(id: string): IMathRun {
  return { id, gameId: 'g1', params: {} as never, verdict: 'pass', metrics: null, trace: [], profile: null, createdAt: 't', durationMs: null };
}

beforeEach(() => {
  rootStore.plugins.nested(MATH_ANALYTICS_PLUGIN_ID).set(makeInitialState() as never);
  fetchRuns.mockReset();
});

describe('openGameAnalytics', () => {
  it('loads the run history for the game and selects the newest run', async () => {
    fetchRuns.mockResolvedValue([run('r2'), run('r1')]);
    await openGameAnalytics('g1');
    expect(analyticsSlice().activeGameId.get()).toBe('g1');
    expect(
      analyticsSlice()
        .runs.get()
        .map((r) => r.id),
    ).toEqual(['r2', 'r1']);
    expect(analyticsSlice().selectedRunId.get()).toBe('r2');
    expect(analyticsSlice().loadStatus.get()).toBe('idle');
  });

  it('sets loadStatus to error when the fetch fails', async () => {
    fetchRuns.mockRejectedValue(new Error('boom'));
    await openGameAnalytics('g1');
    expect(analyticsSlice().loadStatus.get()).toBe('error');
  });
});

describe('closeGameAnalytics', () => {
  it('resets the slice back to its initial state', async () => {
    fetchRuns.mockResolvedValue([run('r1')]);
    await openGameAnalytics('g1');
    closeGameAnalytics();
    expect(analyticsSlice().activeGameId.get()).toBeNull();
    expect(analyticsSlice().runs.get()).toEqual([]);
    expect(analyticsSlice().selectedRunId.get()).toBeNull();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { MATH_PLUGIN_ID, makeInitialState, mathSlice } from './state';
import type { IMathRun } from './state';

const fetchRuns = vi.fn();
vi.mock('./restClient', () => ({
  fetchRuns: (gameId: string, limit?: number) => fetchRuns(gameId, limit),
  fetchRun: vi.fn(),
}));

// Avoid pulling in the real socket.io client at module load (mirrors the tuner
// plugin's actions.spec.ts).
const connect = vi.fn();
const joinMath = vi.fn();
const leaveMath = vi.fn();
vi.mock('./socketClient', () => ({
  mathSock: () => ({ connect, joinMath, leaveMath }),
}));

import { openGameMath, closeGameMath } from './actions';

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
    verify: null,
    locks: null,
  };
}

beforeEach(() => {
  rootStore.plugins.nested(MATH_PLUGIN_ID).set(makeInitialState() as never);
  fetchRuns.mockReset();
  connect.mockReset();
  joinMath.mockReset();
  leaveMath.mockReset();
});

describe('openGameMath', () => {
  it('loads the run history for the game and selects the newest run', async () => {
    fetchRuns.mockResolvedValue([run('r2'), run('r1')]);
    await openGameMath('g1');
    expect(mathSlice().activeGameId.get()).toBe('g1');
    expect(
      mathSlice()
        .runs.get()
        .map((r) => r.id),
    ).toEqual(['r2', 'r1']);
    expect(mathSlice().selectedRunId.get()).toBe('r2');
    expect(mathSlice().loadStatus.get()).toBe('idle');
  });

  it('sets loadStatus to error when the fetch fails', async () => {
    fetchRuns.mockRejectedValue(new Error('boom'));
    await openGameMath('g1');
    expect(mathSlice().loadStatus.get()).toBe('error');
  });

  it('joins the analytics socket room for the game', async () => {
    fetchRuns.mockResolvedValue([]);
    await openGameMath('g1');
    expect(joinMath).toHaveBeenCalledWith('g1');
  });
});

describe('closeGameMath', () => {
  it('resets the slice back to its initial state', async () => {
    fetchRuns.mockResolvedValue([run('r1')]);
    await openGameMath('g1');
    closeGameMath();
    expect(mathSlice().activeGameId.get()).toBeNull();
    expect(mathSlice().runs.get()).toEqual([]);
    expect(mathSlice().selectedRunId.get()).toBeNull();
  });

  it('leaves the analytics socket room for the previously-active game', async () => {
    fetchRuns.mockResolvedValue([]);
    await openGameMath('g1');
    closeGameMath();
    expect(leaveMath).toHaveBeenCalledWith('g1');
  });

  it('does not emit leave when no game was active', () => {
    closeGameMath();
    expect(leaveMath).not.toHaveBeenCalled();
  });
});

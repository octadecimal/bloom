import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { MATH_PLUGIN_ID, makeInitialState, mathSlice } from './state';
import type { IMathRun } from './state';

const handlers: Record<string, (p: unknown) => void> = {};
const emit = vi.fn();
const disconnect = vi.fn();
vi.mock('socket.io-client', () => ({
  io: () => ({
    on: (event: string, cb: (p: unknown) => void) => {
      handlers[event] = cb;
    },
    emit,
    disconnect,
  }),
}));

import { createMathSocket } from './socketClient';

function run(id: string): IMathRun {
  return {
    id,
    gameId: 'g1',
    params: {} as never,
    verdict: 'pass',
    metrics: null,
    trace: [
      {
        generation: 0,
        bestFitness: -0.2,
        bestRtp: 0.9,
        bestVolatility: 2,
        population: { min: 0.1, q1: 0.2, median: 0.3, q3: 0.4, max: 0.5, mean: 0.3, diversity: 0.4 },
        geneAgreement: [0.5, 0.6],
      },
    ],
    profile: null,
    createdAt: 't',
    durationMs: null,
  };
}

beforeEach(() => {
  rootStore.plugins.nested(MATH_PLUGIN_ID).set(makeInitialState() as never);
  createMathSocket().disconnect(); // reset module-level sock so connect() re-registers handlers
  for (const k of Object.keys(handlers)) delete handlers[k];
  emit.mockReset();
  disconnect.mockReset();
  mathSlice().activeGameId.set('g1');
});

describe('analytics socketClient', () => {
  it('appends a live frame for the active game on analytics_progress', () => {
    createMathSocket().connect();
    handlers['analytics_progress']({
      gameId: 'g1',
      generation: 3,
      maxGenerations: 40,
      best: { fitness: -0.1, rtp: 0.91, volatility: 2.1 },
      population: { min: 0.1, q1: 0.2, median: 0.3, q3: 0.4, max: 0.5, mean: 0.3, diversity: 0.3 },
      geneAgreement: [0.4, 0.5],
    });
    const frames = mathSlice().frames.get();
    expect(frames).toHaveLength(1);
    expect(frames[0].generation).toBe(3);
    expect(frames[0].best.rtp).toBe(0.91);
  });

  it('ignores analytics_progress for other games', () => {
    createMathSocket().connect();
    handlers['analytics_progress']({
      gameId: 'other',
      generation: 1,
      maxGenerations: 40,
      best: { fitness: 0, rtp: 0, volatility: 0 },
      population: { min: 0, q1: 0, median: 0, q3: 0, max: 0, mean: 0, diversity: 0 },
      geneAgreement: [],
    });
    expect(mathSlice().frames.get()).toEqual([]);
  });

  it('freezes and stores the run for the active game on run_complete', () => {
    createMathSocket().connect();
    handlers['run_complete']({ gameId: 'g1', run: run('r1') });
    expect(
      mathSlice()
        .runs.get()
        .map((r) => r.id),
    ).toEqual(['r1']);
    expect(mathSlice().frames.get()).toHaveLength(1);
    expect(mathSlice().selectedGeneration.get()).toBe(0);
  });

  it('ignores run_complete for other games', () => {
    createMathSocket().connect();
    handlers['run_complete']({ gameId: 'other', run: run('r1') });
    expect(mathSlice().runs.get()).toEqual([]);
  });

  it('joinMath/leaveMath emit the room events', () => {
    const sock = createMathSocket();
    sock.connect();
    sock.joinMath('g1');
    sock.leaveMath('g1');
    expect(emit).toHaveBeenCalledWith('join_analytics', { gameId: 'g1' });
    expect(emit).toHaveBeenCalledWith('leave_analytics', { gameId: 'g1' });
  });
});

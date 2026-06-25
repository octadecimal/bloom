import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { TUNER_PLUGIN_ID, makeInitialState } from './state';

const handlers: Record<string, (p: unknown) => void> = {};
vi.mock('socket.io-client', () => ({
  io: () => ({
    on: (event: string, cb: (p: unknown) => void) => {
      handlers[event] = cb;
    },
    emit: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

import { createTunerSocket } from './socketClient';
import { tunerSlice } from './state';

beforeEach(() => {
  rootStore.plugins.nested(TUNER_PLUGIN_ID).set(makeInitialState() as never);
  createTunerSocket().disconnect(); // reset module-level sock so connect() re-registers handlers
  for (const k of Object.keys(handlers)) delete handlers[k];
  tunerSlice().activeGameId.set('g1');
  tunerSlice().status.set('idle');
  tunerSlice().progress.set(null);
  tunerSlice().result.set(null);
});

describe('tuner socketClient', () => {
  it('updates progress for the active game', () => {
    createTunerSocket().connect();
    handlers['tuning_progress']({ gameId: 'g1', generation: 3, maxGenerations: 40, bestFitness: -0.1, bestRtp: 0.85, bestVolatility: 2.1 });
    expect(tunerSlice().progress.get()?.generation).toBe(3);
    expect(tunerSlice().status.get()).toBe('running');
  });

  it('ignores events for other games', () => {
    createTunerSocket().connect();
    handlers['tuning_progress']({ gameId: 'other', generation: 9, maxGenerations: 40, bestFitness: 0, bestRtp: 0, bestVolatility: 0 });
    expect(tunerSlice().progress.get()).toBeNull();
  });

  it('sets the verdict status on tuning_complete', () => {
    createTunerSocket().connect();
    handlers['tuning_complete']({ gameId: 'g1', doc: { result: { status: 'near_miss' } } });
    expect(tunerSlice().status.get()).toBe('near_miss');
  });
});

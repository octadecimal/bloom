import { describe, it, expect, beforeEach } from 'vitest';
import { PARAM_FIELDS, PARAM_GROUPS, resetGroup } from './paramFields';
import { MATH_PLUGIN_ID, makeInitialState, mathSlice } from '../state';
import { rootStore } from '../../../state/rootStore';

const tunerParams = {
  masterSeed: 2026,
  population: 24,
  maxGenerations: 40,
  searchCandidateCount: 20000,
  finalCandidateCount: 200000,
  elitism: 2,
  mutationRate: 0.25,
  crossoverRate: 0.9,
  stagnationWindow: 12,
  weights: { rtp: 1, volatility: 1, hitRate: 1 },
};

const curationParams = {
  poolSize: 500,
  candidateCount: 20000,
  masterSeed: 2026,
  rtpTolerance: 0.02,
  realizedCorrectionBand: 0.05,
  bonusRateTolerance: 0.25,
};

beforeEach(() => {
  rootStore.plugins.nested(MATH_PLUGIN_ID).set(makeInitialState() as never);
});

describe('paramFields registry', () => {
  it('covers all 18 wire fields with unique keys and preserves the legacy testid keys', () => {
    const keys = PARAM_FIELDS.map((f) => f.key);
    expect(keys).toHaveLength(18);
    expect(new Set(keys).size).toBe(18);
    expect(keys).toContain('master-seed'); // legacy testid param-master-seed
    expect(keys).toContain('pool-size'); // legacy testid param-pool-size
  });

  it('has three groups, each non-empty', () => {
    expect(PARAM_GROUPS.map((g) => g.id)).toEqual(['tuner', 'weights', 'curation']);
    for (const g of PARAM_GROUPS) {
      expect(PARAM_FIELDS.some((f) => f.group === g.id)).toBe(true);
    }
  });

  it('defaults mirror studio/backend/app/math/models.py', () => {
    const byKey = Object.fromEntries(PARAM_FIELDS.map((f) => [f.key, f.defaultValue]));
    expect(byKey).toMatchObject({
      'master-seed': 2026,
      population: 24,
      generations: 40,
      'search-spins': 20000,
      'final-spins': 200000,
      elitism: 2,
      mutation: 0.25,
      crossover: 0.9,
      stagnation: 12,
      'weight-rtp': 1.0,
      'weight-volatility': 1.0,
      'weight-hit-rate': 1.0,
      'pool-size': 1000,
      candidates: 50000,
      'sim-seed': 2026,
      'rtp-tolerance': 0.01,
      'correction-band': 0.05,
      'bonus-tolerance': 0.25,
    });
  });

  it('every field carries complete tooltip copy and a positive step', () => {
    for (const f of PARAM_FIELDS) {
      expect(f.tooltip.title.length, f.key).toBeGreaterThan(0);
      expect(f.tooltip.body.length, f.key).toBeGreaterThan(10);
      expect(f.tooltip.effect.length, f.key).toBeGreaterThan(10);
      expect(f.step, f.key).toBeGreaterThan(0);
    }
  });

  it('get returns null before params load, and get/set round-trip through the slice', () => {
    const s = mathSlice();
    for (const f of PARAM_FIELDS) expect(f.get(s), f.key).toBeNull();
    s.tunerParams.set({ ...tunerParams, weights: { ...tunerParams.weights } });
    s.curationParams.set({ ...curationParams });
    for (const f of PARAM_FIELDS) {
      const v = f.integer ? f.defaultValue + 1 : f.defaultValue + 0.01;
      f.set(s, v);
      expect(f.get(s), f.key).toBeCloseTo(v, 10);
    }
  });

  it('resetGroup restores only its own group', () => {
    const s = mathSlice();
    s.tunerParams.set({ ...tunerParams, population: 99, weights: { ...tunerParams.weights, rtp: 9 } });
    s.curationParams.set({ ...curationParams, poolSize: 77 });
    resetGroup(s, 'tuner');
    expect(s.tunerParams.get()?.population).toBe(24);
    expect(s.tunerParams.get()?.weights.rtp).toBe(9); // weights is its own group
    expect(s.curationParams.get()?.poolSize).toBe(77); // curation untouched
    resetGroup(s, 'curation');
    expect(s.curationParams.get()?.poolSize).toBe(1000);
  });
});

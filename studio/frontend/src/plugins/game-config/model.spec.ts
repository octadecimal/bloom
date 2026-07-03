import { describe, it, expect } from 'vitest';
import { emptyModel, normalizeModel } from './model';

describe('emptyModel', () => {
  it('returns a structurally complete empty slots@1 model', () => {
    expect(emptyModel()).toEqual({
      symbols: [],
      reels: [],
      rows: 3,
      paylines: [],
      paytable: { entries: [] },
      bonuses: [],
    });
  });
});

describe('normalizeModel', () => {
  it('fills missing fields on an empty doc model ({})', () => {
    expect(normalizeModel({})).toEqual(emptyModel());
  });

  it('fills missing fields on null/undefined', () => {
    expect(normalizeModel(null)).toEqual(emptyModel());
    expect(normalizeModel(undefined)).toEqual(emptyModel());
  });

  it('passes a complete model through untouched', () => {
    const m = {
      symbols: [{ id: 0, role: 'normal' }],
      reels: [[0, 0]],
      rows: 1,
      paylines: [[0]],
      paytable: { entries: [{ symbol: 0, count: 1, payout: 1 }] },
      bonuses: [],
    };
    expect(normalizeModel(m)).toEqual(m);
  });

  it('replaces malformed fields with defaults but keeps good ones', () => {
    const out = normalizeModel({ rows: 'x', reels: [[1]], paytable: 5 });
    expect(out.rows).toBe(3);
    expect(out.reels).toEqual([[1]]);
    expect(out.paytable).toEqual({ entries: [] });
  });
});

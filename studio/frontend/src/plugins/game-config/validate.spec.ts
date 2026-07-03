import { describe, it, expect } from 'vitest';
import type { ISlotModel } from './model';
import { validateModel } from './validate';

// A fully valid 3-reel model used as the mutation base for each check.
function valid(): ISlotModel {
  return {
    symbols: [
      { id: 0, role: 'normal' },
      { id: 1, role: 'wild' },
      { id: 9, role: 'scatter' },
    ],
    reels: [
      [0, 1, 9, 0, 0],
      [0, 0, 1, 9, 0],
      [9, 0, 1, 0, 0],
    ],
    rows: 3,
    paylines: [
      [0, 0, 0],
      [1, 1, 1],
    ],
    paytable: {
      entries: [
        { symbol: 0, count: 3, payout: 5 },
        { symbol: 9, count: 3, payout: 2 },
      ],
    },
    bonuses: [
      {
        FreeSpins: {
          trigger: { symbol: 9, min_count: 3 },
          config: { spins_awarded: 5, retrigger: true, multiplier: 2, feature_reels: null },
        },
      },
    ],
  };
}

function issuesFor(m: ISlotModel, tab?: string) {
  const issues = validateModel(m);
  return tab ? issues.filter((i) => i.tab === tab) : issues;
}

describe('validateModel', () => {
  it('returns no issues for a valid model', () => {
    expect(validateModel(valid())).toEqual([]);
  });

  it('errors when there are no reels / empty strips / rows < 1', () => {
    expect(issuesFor({ ...valid(), reels: [] }, 'reels').some((i) => i.severity === 'error')).toBe(true);
    const m = valid();
    m.reels = [m.reels[0], [], m.reels[2]];
    expect(issuesFor(m, 'reels').some((i) => i.path === 'reels[1]')).toBe(true);
    expect(issuesFor({ ...valid(), rows: 0 }, 'reels').some((i) => i.path === 'rows')).toBe(true);
  });

  it('errors on duplicate symbol ids and out-of-range ids', () => {
    const m = valid();
    m.symbols = [...m.symbols, { id: 0, role: 'normal' }];
    expect(issuesFor(m, 'symbols').some((i) => i.severity === 'error')).toBe(true);
    const m2 = valid();
    m2.symbols[0] = { id: 300, role: 'normal' };
    expect(issuesFor(m2, 'symbols').length).toBeGreaterThan(0);
  });

  it('errors when a strip references an unknown symbol', () => {
    const m = valid();
    m.reels = [[0, 7], m.reels[1], m.reels[2]];
    expect(issuesFor(m, 'reels').some((i) => i.path === 'reels[0]' && i.severity === 'error')).toBe(true);
  });

  it('errors on payline length mismatch and out-of-range rows', () => {
    const m = valid();
    m.paylines = [
      [0, 0],
      [1, 1, 1],
    ];
    expect(issuesFor(m, 'paylines').some((i) => i.path === 'paylines[0]')).toBe(true);
    const m2 = valid();
    m2.paylines = [
      [0, 0, 5],
      [1, 1, 1],
    ];
    expect(issuesFor(m2, 'paylines').some((i) => i.path === 'paylines[0]')).toBe(true);
  });

  it('flags paytable problems: unknown symbol (error), duplicate row + zero payout (warnings)', () => {
    const m = valid();
    m.paytable = { entries: [...m.paytable.entries, { symbol: 42, count: 3, payout: 1 }] };
    expect(issuesFor(m, 'paytable').some((i) => i.severity === 'error')).toBe(true);
    const m2 = valid();
    m2.paytable = { entries: [...m2.paytable.entries, { symbol: 0, count: 3, payout: 9 }] };
    expect(issuesFor(m2, 'paytable').some((i) => i.severity === 'warning')).toBe(true);
    const m3 = valid();
    m3.paytable = { entries: [{ symbol: 0, count: 3, payout: 0 }] };
    expect(issuesFor(m3, 'paytable').some((i) => i.severity === 'warning')).toBe(true);
  });

  it('flags bonus problems: unknown trigger symbol (error), non-scatter trigger (warning), bad counts (error)', () => {
    const m = valid();
    m.bonuses[0].FreeSpins.trigger.symbol = 42;
    expect(issuesFor(m, 'bonus').some((i) => i.severity === 'error')).toBe(true);
    const m2 = valid();
    m2.bonuses[0].FreeSpins.trigger.symbol = 0; // exists but role normal
    expect(issuesFor(m2, 'bonus').some((i) => i.severity === 'warning')).toBe(true);
    const m3 = valid();
    m3.bonuses[0].FreeSpins.config.spins_awarded = 0;
    expect(issuesFor(m3, 'bonus').some((i) => i.severity === 'error')).toBe(true);
  });

  it('validates feature reels like base reels (count, emptiness, unknown symbols)', () => {
    const m = valid();
    m.bonuses[0].FreeSpins.config.feature_reels = [[0], [7]]; // wrong count + unknown symbol
    const issues = issuesFor(m, 'bonus');
    expect(issues.some((i) => i.path === 'bonuses[0]')).toBe(true); // reel-count mismatch
    expect(issues.some((i) => i.path === 'bonuses[0].feature_reels[1]')).toBe(true); // unknown symbol
  });

  it('errors on non-integer numeric fields', () => {
    const m = valid();
    m.paytable.entries[0].payout = 1.5;
    expect(issuesFor(m, 'paytable').some((i) => i.severity === 'error')).toBe(true);
  });
});

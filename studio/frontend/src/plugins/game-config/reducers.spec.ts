import { describe, it, expect } from 'vitest';
import type { ISlotModel } from './model';
import {
  addSymbol,
  removeSymbol,
  setSymbolRole,
  getStrips,
  countOccurrences,
  insertStripCell,
  replaceStripCell,
  removeStripCell,
  moveStripCell,
  appendStripCell,
  setSymbolCount,
  setRows,
  setReelCount,
  addFeatureReels,
  clearFeatureReels,
  addPayline,
  duplicatePayline,
  removePayline,
  setPaylineCell,
  addPaytableRow,
  updatePaytableRow,
  removePaytableRow,
  addBonus,
  removeBonus,
  updateBonusTrigger,
  updateBonusConfig,
  deriveStats,
} from './reducers';

function base(): ISlotModel {
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
    paytable: { entries: [{ symbol: 0, count: 3, payout: 5 }] },
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

describe('purity', () => {
  it('never mutates the input model', () => {
    const m = base();
    const frozen = JSON.stringify(m);
    addSymbol(m);
    setSymbolCount(m, 'base', 0, 0, 9);
    setReelCount(m, 5);
    removeStripCell(m, 'base', 0, 0);
    addBonus(m);
    expect(JSON.stringify(m)).toBe(frozen);
  });
});

describe('symbols', () => {
  it('addSymbol takes the smallest free id with role normal', () => {
    const out = addSymbol(base());
    expect(out.symbols.map((s) => s.id)).toEqual([0, 1, 9, 2]);
    expect(out.symbols[3].role).toBe('normal');
  });
  it('removeSymbol drops only the symbol def (references remain for validation)', () => {
    const out = removeSymbol(base(), 9);
    expect(out.symbols.map((s) => s.id)).toEqual([0, 1]);
    expect(out.reels[0]).toContain(9);
  });
  it('setSymbolRole updates the role', () => {
    expect(setSymbolRole(base(), 0, 'scatter').symbols[0].role).toBe('scatter');
  });
});

describe('strips', () => {
  it('getStrips resolves base and feature sets', () => {
    const m = base();
    expect(getStrips(m, 'base')).toBe(m.reels);
    expect(getStrips(m, 0)).toBeNull();
    const withFeature = addFeatureReels(m, 0);
    expect(getStrips(withFeature, 0)).toEqual(m.reels); // cloned from base
  });
  it('insert/replace/remove/move/append operate on one strip', () => {
    let out = insertStripCell(base(), 'base', 0, 1, 9);
    expect(out.reels[0]).toEqual([0, 9, 1, 9, 0, 0]);
    out = replaceStripCell(base(), 'base', 0, 0, 1);
    expect(out.reels[0]).toEqual([1, 1, 9, 0, 0]);
    out = removeStripCell(base(), 'base', 0, 2);
    expect(out.reels[0]).toEqual([0, 1, 0, 0]);
    out = moveStripCell(base(), 'base', 0, 0, 2);
    expect(out.reels[0]).toEqual([1, 9, 0, 0, 0]);
    out = appendStripCell(base(), 'base', 1, 1);
    expect(out.reels[1]).toEqual([0, 0, 1, 9, 0, 1]);
  });
  it('setSymbolCount appends on increment and removes LAST occurrences on decrement, preserving order', () => {
    const m = base(); // reel 0 = [0,1,9,0,0] -> three 0s
    let out = setSymbolCount(m, 'base', 0, 0, 5);
    expect(out.reels[0]).toEqual([0, 1, 9, 0, 0, 0, 0]);
    out = setSymbolCount(m, 'base', 0, 0, 1);
    expect(out.reels[0]).toEqual([0, 1, 9]);
    expect(countOccurrences(out.reels[0], 0)).toBe(1);
  });
  it('setSymbolCount edits feature strips through the ref', () => {
    const m = addFeatureReels(base(), 0);
    const out = setSymbolCount(m, 0, 0, 9, 3);
    expect(countOccurrences(out.bonuses[0].FreeSpins.config.feature_reels![0], 9)).toBe(3);
    expect(countOccurrences(out.reels[0], 9)).toBe(1); // base untouched
  });
});

describe('window', () => {
  it('setRows updates rows', () => {
    expect(setRows(base(), 4).rows).toBe(4);
  });
  it('setReelCount grows reels/paylines/feature strips and shrinks them symmetrically', () => {
    const m = addFeatureReels(base(), 0);
    const grown = setReelCount(m, 5);
    expect(grown.reels).toHaveLength(5);
    expect(grown.reels[3]).toEqual([]);
    expect(grown.paylines[0]).toEqual([0, 0, 0, 0, 0]); // padded with row 0
    expect(grown.bonuses[0].FreeSpins.config.feature_reels).toHaveLength(5);
    const shrunk = setReelCount(m, 2);
    expect(shrunk.reels).toHaveLength(2);
    expect(shrunk.paylines[1]).toEqual([1, 1]);
    expect(shrunk.bonuses[0].FreeSpins.config.feature_reels).toHaveLength(2);
  });
});

describe('paylines', () => {
  it('add/duplicate/remove/setCell', () => {
    let out = addPayline(base());
    expect(out.paylines[2]).toEqual([0, 0, 0]);
    out = duplicatePayline(base(), 1);
    expect(out.paylines).toHaveLength(3);
    expect(out.paylines[2]).toEqual([1, 1, 1]);
    out = removePayline(base(), 0);
    expect(out.paylines).toEqual([[1, 1, 1]]);
    out = setPaylineCell(base(), 0, 1, 2);
    expect(out.paylines[0]).toEqual([0, 2, 0]);
  });
});

describe('paytable', () => {
  it('add/update/remove rows', () => {
    let out = addPaytableRow(base(), 1);
    expect(out.paytable.entries[1]).toEqual({ symbol: 1, count: 3, payout: 0 });
    out = updatePaytableRow(base(), 0, { payout: 10 });
    expect(out.paytable.entries[0].payout).toBe(10);
    out = removePaytableRow(base(), 0);
    expect(out.paytable.entries).toEqual([]);
  });
});

describe('bonuses', () => {
  it('addBonus defaults trigger to the first scatter', () => {
    const out = addBonus(base());
    expect(out.bonuses).toHaveLength(2);
    expect(out.bonuses[1].FreeSpins.trigger).toEqual({ symbol: 9, min_count: 3 });
    expect(out.bonuses[1].FreeSpins.config.feature_reels).toBeNull();
  });
  it('update trigger/config and remove; clearFeatureReels nulls the strips', () => {
    let out = updateBonusTrigger(base(), 0, { min_count: 4 });
    expect(out.bonuses[0].FreeSpins.trigger.min_count).toBe(4);
    out = updateBonusConfig(base(), 0, { spins_awarded: 8, retrigger: false });
    expect(out.bonuses[0].FreeSpins.config.spins_awarded).toBe(8);
    expect(out.bonuses[0].FreeSpins.config.retrigger).toBe(false);
    out = clearFeatureReels(addFeatureReels(base(), 0), 0);
    expect(out.bonuses[0].FreeSpins.config.feature_reels).toBeNull();
    out = removeBonus(base(), 0);
    expect(out.bonuses).toEqual([]);
  });
});

describe('deriveStats', () => {
  it('summarizes the model', () => {
    expect(deriveStats(base())).toEqual({
      rows: 3,
      reelCount: 3,
      symbolCount: 3,
      paylineCount: 2,
      stripLengths: [5, 5, 5],
    });
  });
});

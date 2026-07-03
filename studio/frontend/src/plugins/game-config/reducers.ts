// Pure model transforms. Every function returns a NEW model; inputs are never mutated.
import type { IFreeSpinsConfig, IPaytableEntry, ISlotModel, ITriggerSpec, SymbolRole } from './model';

export type ReelSetRef = 'base' | number;

export interface IModelStats {
  rows: number;
  reelCount: number;
  symbolCount: number;
  paylineCount: number;
  stripLengths: number[];
}

export function getStrips(m: ISlotModel, ref: ReelSetRef): number[][] | null {
  if (ref === 'base') return m.reels;
  return m.bonuses[ref]?.FreeSpins.config.feature_reels ?? null;
}

export function countOccurrences(strip: number[], symbol: number): number {
  return strip.reduce((n, s) => (s === symbol ? n + 1 : n), 0);
}

function withStrips(m: ISlotModel, ref: ReelSetRef, strips: number[][]): ISlotModel {
  if (ref === 'base') return { ...m, reels: strips };
  return {
    ...m,
    bonuses: m.bonuses.map((b, i) => (i === ref ? { FreeSpins: { ...b.FreeSpins, config: { ...b.FreeSpins.config, feature_reels: strips } } } : b)),
  };
}

function withStrip(m: ISlotModel, ref: ReelSetRef, reel: number, strip: number[]): ISlotModel {
  const strips = getStrips(m, ref);
  if (!strips) return m;
  return withStrips(
    m,
    ref,
    strips.map((s, i) => (i === reel ? strip : s)),
  );
}

// ── Symbols ────────────────────────────────────────────────────────────────

export function addSymbol(m: ISlotModel): ISlotModel {
  const used = new Set(m.symbols.map((s) => s.id));
  let id = 0;
  while (used.has(id) && id <= 255) id++;
  return { ...m, symbols: [...m.symbols, { id, role: 'normal' }] };
}

export function removeSymbol(m: ISlotModel, id: number): ISlotModel {
  return { ...m, symbols: m.symbols.filter((s) => s.id !== id) };
}

export function setSymbolRole(m: ISlotModel, id: number, role: SymbolRole): ISlotModel {
  return { ...m, symbols: m.symbols.map((s) => (s.id === id ? { ...s, role } : s)) };
}

// ── Strip cells ────────────────────────────────────────────────────────────

export function insertStripCell(m: ISlotModel, ref: ReelSetRef, reel: number, index: number, symbol: number): ISlotModel {
  const strip = getStrips(m, ref)?.[reel];
  if (!strip) return m;
  return withStrip(m, ref, reel, [...strip.slice(0, index), symbol, ...strip.slice(index)]);
}

export function replaceStripCell(m: ISlotModel, ref: ReelSetRef, reel: number, index: number, symbol: number): ISlotModel {
  const strip = getStrips(m, ref)?.[reel];
  if (!strip) return m;
  return withStrip(
    m,
    ref,
    reel,
    strip.map((s, i) => (i === index ? symbol : s)),
  );
}

export function removeStripCell(m: ISlotModel, ref: ReelSetRef, reel: number, index: number): ISlotModel {
  const strip = getStrips(m, ref)?.[reel];
  if (!strip) return m;
  return withStrip(
    m,
    ref,
    reel,
    strip.filter((_, i) => i !== index),
  );
}

export function moveStripCell(m: ISlotModel, ref: ReelSetRef, reel: number, from: number, to: number): ISlotModel {
  const strip = getStrips(m, ref)?.[reel];
  if (!strip || from === to) return m;
  const next = [...strip];
  const [cell] = next.splice(from, 1);
  next.splice(to, 0, cell);
  return withStrip(m, ref, reel, next);
}

export function appendStripCell(m: ISlotModel, ref: ReelSetRef, reel: number, symbol: number): ISlotModel {
  const strip = getStrips(m, ref)?.[reel];
  if (!strip) return m;
  return withStrip(m, ref, reel, [...strip, symbol]);
}

/** Composition-view semantics: increment appends; decrement removes the LAST
 *  occurrences; order of everything else is preserved. */
export function setSymbolCount(m: ISlotModel, ref: ReelSetRef, reel: number, symbol: number, count: number): ISlotModel {
  const strip = getStrips(m, ref)?.[reel];
  if (!strip || count < 0) return m;
  const current = countOccurrences(strip, symbol);
  if (count > current) {
    return withStrip(m, ref, reel, [...strip, ...Array<number>(count - current).fill(symbol)]);
  }
  if (count < current) {
    const next = [...strip];
    let toRemove = current - count;
    for (let i = next.length - 1; i >= 0 && toRemove > 0; i--) {
      if (next[i] === symbol) {
        next.splice(i, 1);
        toRemove--;
      }
    }
    return withStrip(m, ref, reel, next);
  }
  return m;
}

// ── Window ─────────────────────────────────────────────────────────────────

export function setRows(m: ISlotModel, rows: number): ISlotModel {
  if (!Number.isInteger(rows) || rows < 1) return m;
  return { ...m, rows };
}

function resizeStripSet(strips: number[][], count: number): number[][] {
  if (count <= strips.length) return strips.slice(0, count);
  return [...strips, ...Array.from({ length: count - strips.length }, () => [] as number[])];
}

export function setReelCount(m: ISlotModel, count: number): ISlotModel {
  if (!Number.isInteger(count) || count < 1) return m;
  const paylines = m.paylines.map((line) => (line.length <= count ? [...line, ...Array<number>(count - line.length).fill(0)] : line.slice(0, count)));
  const bonuses = m.bonuses.map((b) => {
    const fr = b.FreeSpins.config.feature_reels;
    if (fr === null) return b;
    return { FreeSpins: { ...b.FreeSpins, config: { ...b.FreeSpins.config, feature_reels: resizeStripSet(fr, count) } } };
  });
  return { ...m, reels: resizeStripSet(m.reels, count), paylines, bonuses };
}

// ── Feature reels ──────────────────────────────────────────────────────────

export function addFeatureReels(m: ISlotModel, bonusIndex: number): ISlotModel {
  const clone = m.reels.map((strip) => [...strip]);
  return withStrips(m, bonusIndex, clone);
}

export function clearFeatureReels(m: ISlotModel, bonusIndex: number): ISlotModel {
  return {
    ...m,
    bonuses: m.bonuses.map((b, i) => (i === bonusIndex ? { FreeSpins: { ...b.FreeSpins, config: { ...b.FreeSpins.config, feature_reels: null } } } : b)),
  };
}

// ── Paylines ───────────────────────────────────────────────────────────────

export function addPayline(m: ISlotModel): ISlotModel {
  return { ...m, paylines: [...m.paylines, Array<number>(m.reels.length).fill(0)] };
}

export function duplicatePayline(m: ISlotModel, index: number): ISlotModel {
  const line = m.paylines[index];
  if (!line) return m;
  return { ...m, paylines: [...m.paylines, [...line]] };
}

export function removePayline(m: ISlotModel, index: number): ISlotModel {
  return { ...m, paylines: m.paylines.filter((_, i) => i !== index) };
}

export function setPaylineCell(m: ISlotModel, index: number, reel: number, row: number): ISlotModel {
  return {
    ...m,
    paylines: m.paylines.map((line, i) => (i === index ? line.map((r, j) => (j === reel ? row : r)) : line)),
  };
}

// ── Paytable ───────────────────────────────────────────────────────────────

export function addPaytableRow(m: ISlotModel, symbol: number): ISlotModel {
  return { ...m, paytable: { entries: [...m.paytable.entries, { symbol, count: 3, payout: 0 }] } };
}

export function updatePaytableRow(m: ISlotModel, index: number, patch: Partial<IPaytableEntry>): ISlotModel {
  return {
    ...m,
    paytable: { entries: m.paytable.entries.map((e, i) => (i === index ? { ...e, ...patch } : e)) },
  };
}

export function removePaytableRow(m: ISlotModel, index: number): ISlotModel {
  return { ...m, paytable: { entries: m.paytable.entries.filter((_, i) => i !== index) } };
}

// ── Bonuses ────────────────────────────────────────────────────────────────

export function addBonus(m: ISlotModel): ISlotModel {
  const scatter = m.symbols.find((s) => s.role === 'scatter');
  return {
    ...m,
    bonuses: [
      ...m.bonuses,
      {
        FreeSpins: {
          trigger: { symbol: scatter?.id ?? 0, min_count: 3 },
          config: { spins_awarded: 5, retrigger: false, multiplier: 1, feature_reels: null },
        },
      },
    ],
  };
}

export function removeBonus(m: ISlotModel, index: number): ISlotModel {
  return { ...m, bonuses: m.bonuses.filter((_, i) => i !== index) };
}

export function updateBonusTrigger(m: ISlotModel, index: number, patch: Partial<ITriggerSpec>): ISlotModel {
  return {
    ...m,
    bonuses: m.bonuses.map((b, i) => (i === index ? { FreeSpins: { ...b.FreeSpins, trigger: { ...b.FreeSpins.trigger, ...patch } } } : b)),
  };
}

export function updateBonusConfig(m: ISlotModel, index: number, patch: Partial<Omit<IFreeSpinsConfig, 'feature_reels'>>): ISlotModel {
  return {
    ...m,
    bonuses: m.bonuses.map((b, i) => (i === index ? { FreeSpins: { ...b.FreeSpins, config: { ...b.FreeSpins.config, ...patch } } } : b)),
  };
}

// ── Stats ──────────────────────────────────────────────────────────────────

export function deriveStats(m: ISlotModel): IModelStats {
  return {
    rows: m.rows,
    reelCount: m.reels.length,
    symbolCount: m.symbols.length,
    paylineCount: m.paylines.length,
    stripLengths: m.reels.map((s) => s.length),
  };
}

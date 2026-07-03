// Client-side slots@1 invariants. Advisory: invalid states are still saveable
// (the store is a working doc); Rust serde at curate time is the final gate.
import type { ISlotModel } from './model';

export type GcTab = 'symbols' | 'reels' | 'paylines' | 'paytable' | 'bonus' | 'json';

export interface IValidationIssue {
  tab: GcTab;
  path: string;
  severity: 'error' | 'warning';
  message: string;
}

function isUint(n: number, max: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= max;
}

const U8 = 255;
const U32 = 4294967295;

export function validateModel(m: ISlotModel): IValidationIssue[] {
  const issues: IValidationIssue[] = [];
  const err = (tab: GcTab, path: string, message: string) => issues.push({ tab, path, severity: 'error', message });
  const warn = (tab: GcTab, path: string, message: string) => issues.push({ tab, path, severity: 'warning', message });

  // Symbols
  const ids = new Set<number>();
  m.symbols.forEach((s, i) => {
    if (!isUint(s.id, U8)) err('symbols', `symbols[${i}]`, `symbol id ${s.id} must be an integer 0-255`);
    if (ids.has(s.id)) err('symbols', `symbols[${i}]`, `duplicate symbol id ${s.id}`);
    ids.add(s.id);
  });

  // Window + reels
  if (!Number.isInteger(m.rows) || m.rows < 1) err('reels', 'rows', 'rows must be an integer >= 1');
  if (m.reels.length === 0) err('reels', 'reels', 'the model needs at least one reel');
  const checkStrips = (strips: number[][], tab: GcTab, pathFor: (r: number) => string) => {
    strips.forEach((strip, r) => {
      if (strip.length === 0) err(tab, pathFor(r), 'empty reel strip');
      const unknown = strip.filter((sym) => !ids.has(sym));
      if (unknown.length > 0) err(tab, pathFor(r), `strip references unknown symbol ${unknown[0]}`);
    });
  };
  checkStrips(m.reels, 'reels', (r) => `reels[${r}]`);

  // Paylines
  m.paylines.forEach((line, i) => {
    if (line.length !== m.reels.length) err('paylines', `paylines[${i}]`, `line has ${line.length} entries; must equal reel count ${m.reels.length}`);
    line.forEach((row) => {
      if (!Number.isInteger(row) || row < 0 || row >= m.rows) err('paylines', `paylines[${i}]`, `row index ${row} is outside 0-${m.rows - 1}`);
    });
  });

  // Paytable
  const seen = new Set<string>();
  m.paytable.entries.forEach((e, i) => {
    if (!ids.has(e.symbol)) err('paytable', `paytable.entries[${i}]`, `unknown symbol ${e.symbol}`);
    if (!isUint(e.count, U8) || e.count < 1) err('paytable', `paytable.entries[${i}]`, 'count must be an integer >= 1');
    if (!Number.isInteger(e.payout) || e.payout < 0) err('paytable', `paytable.entries[${i}]`, 'payout must be a non-negative integer');
    else if (e.payout === 0) warn('paytable', `paytable.entries[${i}]`, 'zero payout row has no effect');
    const key = `${e.symbol}:${e.count}`;
    if (seen.has(key)) warn('paytable', `paytable.entries[${i}]`, `duplicate row for symbol ${e.symbol} x ${e.count}`);
    seen.add(key);
    if (e.count > m.reels.length && m.reels.length > 0) warn('paytable', `paytable.entries[${i}]`, `count ${e.count} exceeds reel count ${m.reels.length}`);
  });

  // Bonuses
  const roleOf = new Map(m.symbols.map((s) => [s.id, s.role]));
  m.bonuses.forEach((b, i) => {
    const { trigger, config } = b.FreeSpins;
    if (!ids.has(trigger.symbol)) err('bonus', `bonuses[${i}]`, `unknown trigger symbol ${trigger.symbol}`);
    else if (roleOf.get(trigger.symbol) !== 'scatter') warn('bonus', `bonuses[${i}]`, 'trigger symbol is not a scatter');
    if (!isUint(trigger.min_count, U8) || trigger.min_count < 1) err('bonus', `bonuses[${i}]`, 'min_count must be an integer >= 1');
    if (!isUint(config.spins_awarded, U32) || config.spins_awarded < 1) err('bonus', `bonuses[${i}]`, 'spins_awarded must be an integer >= 1');
    if (!Number.isInteger(config.multiplier) || config.multiplier < 1) err('bonus', `bonuses[${i}]`, 'multiplier must be an integer >= 1');
    if (config.feature_reels !== null) {
      if (config.feature_reels.length !== m.reels.length)
        err('bonus', `bonuses[${i}]`, `feature reels count ${config.feature_reels.length} must equal reel count ${m.reels.length}`);
      checkStrips(config.feature_reels, 'bonus', (r) => `bonuses[${i}].feature_reels[${r}]`);
    }
  });

  return issues;
}

// TypeScript mirror of the Rust slots@1 schema (trusted/math/src/mechanics/slots/model.rs).
// Inner keys are snake_case: this is the serde wire shape, stored opaque in Mongo.

export type SymbolRole = 'normal' | 'wild' | 'scatter';

export interface ISymbolDef {
  id: number; // u8
  role: SymbolRole;
}

export interface IPaytableEntry {
  symbol: number;
  count: number; // u8; lines: left-aligned run length, scatters: total grid count
  payout: number; // u64 integer bet-multiples
}

export interface IPaytable {
  entries: IPaytableEntry[];
}

export interface ITriggerSpec {
  symbol: number;
  min_count: number;
}

export interface IFreeSpinsConfig {
  spins_awarded: number;
  retrigger: boolean;
  multiplier: number;
  feature_reels: number[][] | null;
}

// Externally-tagged serde enum: {"FreeSpins": {...}} is the only slots@1 variant.
export interface IBonusFeature {
  FreeSpins: { trigger: ITriggerSpec; config: IFreeSpinsConfig };
}

export interface ISlotModel {
  symbols: ISymbolDef[];
  reels: number[][]; // one strip per reel; multiplicity encodes probability
  rows: number;
  paylines: number[][]; // row index per reel; length must equal reel count
  paytable: IPaytable;
  bonuses: IBonusFeature[];
}

export function emptyModel(): ISlotModel {
  return { symbols: [], reels: [], rows: 3, paylines: [], paytable: { entries: [] }, bonuses: [] };
}

/** Coerce the opaque `model` dict from the store (possibly {} on a fresh game) into a
 *  structurally complete ISlotModel. Per-field: keep well-shaped values, default the rest. */
export function normalizeModel(raw: unknown): ISlotModel {
  const base = emptyModel();
  if (typeof raw !== 'object' || raw === null) return base;
  const m = raw as Partial<ISlotModel>;
  return {
    symbols: Array.isArray(m.symbols) ? m.symbols : base.symbols,
    reels: Array.isArray(m.reels) ? m.reels : base.reels,
    rows: typeof m.rows === 'number' ? m.rows : base.rows,
    paylines: Array.isArray(m.paylines) ? m.paylines : base.paylines,
    paytable:
      typeof m.paytable === 'object' && m.paytable !== null && Array.isArray((m.paytable as IPaytable).entries) ? (m.paytable as IPaytable) : base.paytable,
    bonuses: Array.isArray(m.bonuses) ? m.bonuses : base.bonuses,
  };
}

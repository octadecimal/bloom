// Editor-side symbol presentation (labels + swatch roles). Lives OUTSIDE the kernel
// model in the store doc, so tuner Apply / serde round-trips never destroy it.
// Colors are token ROLE NAMES only — actual values live in styles.css (--sym-*).

export interface ISymbolPresentation {
  label: string;
  color: string; // a SWATCHES role name, e.g. 'sym-3'
}

export interface IPresentation {
  symbols: Record<string, ISymbolPresentation>; // keyed by String(symbolId), sparse
}

export const SWATCHES = ['sym-1', 'sym-2', 'sym-3', 'sym-4', 'sym-5', 'sym-6', 'sym-7', 'sym-8', 'sym-9', 'sym-10'] as const;

// Tailwind can't compile dynamic class names — every class is a full literal here.
export const SWATCH_DOT_CLASS: Record<string, string> = {
  'sym-1': 'bg-sym-1',
  'sym-2': 'bg-sym-2',
  'sym-3': 'bg-sym-3',
  'sym-4': 'bg-sym-4',
  'sym-5': 'bg-sym-5',
  'sym-6': 'bg-sym-6',
  'sym-7': 'bg-sym-7',
  'sym-8': 'bg-sym-8',
  'sym-9': 'bg-sym-9',
  'sym-10': 'bg-sym-10',
};

export function emptyPresentation(): IPresentation {
  return { symbols: {} };
}

export function normalizePresentation(raw: unknown): IPresentation {
  if (typeof raw !== 'object' || raw === null) return emptyPresentation();
  const p = raw as Partial<IPresentation>;
  if (typeof p.symbols !== 'object' || p.symbols === null || Array.isArray(p.symbols)) return emptyPresentation();
  return { symbols: p.symbols };
}

export function symbolLabel(p: IPresentation, id: number): string {
  return p.symbols[String(id)]?.label ?? `S${id}`;
}

export function symbolColor(p: IPresentation, id: number): string {
  return p.symbols[String(id)]?.color ?? SWATCHES[id % SWATCHES.length];
}

export function nextFreeSwatch(p: IPresentation): string {
  const used = new Set(Object.values(p.symbols).map((e) => e.color));
  return SWATCHES.find((s) => !used.has(s)) ?? SWATCHES[0];
}

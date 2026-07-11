import type { IGameDefinition, IStateDef } from './model';

export interface IMechanicCatalogEntry {
  type: string;
  label: string;
  defaultConfig: Record<string, unknown>;
}

// Hardcoded per shipped mechanic; a registry is YAGNI until mechanic #3 exists.
export const MECHANIC_CATALOG: IMechanicCatalogEntry[] = [
  {
    type: 'reels@1',
    label: 'Reels',
    defaultConfig: {
      strips: [
        [0, 1, 2, 0, 9, 1, 0, 2, 1, 0],
        [1, 0, 2, 9, 0, 1, 2, 0, 0, 1],
        [2, 1, 0, 0, 1, 9, 0, 2, 1, 0],
      ],
      rows: 3,
      symbols: [
        { id: 0, role: 'normal' },
        { id: 1, role: 'normal' },
        { id: 2, role: 'normal' },
        { id: 9, role: 'scatter' },
      ],
      paylines: [
        [0, 0, 0],
        [1, 1, 1],
        [2, 2, 2],
      ],
      paytable: {
        entries: [
          { symbol: 0, count: 3, payout: 5 },
          { symbol: 1, count: 3, payout: 10 },
          { symbol: 2, count: 3, payout: 20 },
          { symbol: 9, count: 3, payout: 2 },
        ],
      },
      events: [{ symbol: 9, min_count: 3, emit: 'scatters:3' }],
    },
  },
  {
    type: 'meter@1',
    label: 'Meter',
    defaultConfig: { target: 6, count_symbol: 9, reset_on_full: true },
  },
];

export const ACTIONS: Record<string, string[]> = {
  'reels@1': ['spin'],
  'meter@1': ['accumulate'],
};

export const STEPS_EXHAUSTED = 'steps:exhausted';

interface IReelsEvent {
  emit?: unknown;
}

/** Events transitions may bind `on` to: every reels emit string, meter:full if
 *  any meter instance exists, plus the kernel-synthesized steps:exhausted. */
export function emittableEvents(def: IGameDefinition): string[] {
  const out: string[] = [];
  for (const m of def.mechanics) {
    if (m.type === 'reels@1') {
      const events = (m.config.events as IReelsEvent[] | undefined) ?? [];
      for (const e of events) {
        if (typeof e.emit === 'string' && !out.includes(e.emit)) out.push(e.emit);
      }
    }
  }
  if (def.mechanics.some((m) => m.type === 'meter@1') && !out.includes('meter:full')) out.push('meter:full');
  out.push(STEPS_EXHAUSTED);
  return out;
}

/** "<instance>.<action>" options for a state's script, from its bound instances. */
export function invokeOptions(def: IGameDefinition, state: IStateDef): string[] {
  const out: string[] = [];
  for (const b of state.bindings) {
    const decl = def.mechanics.find((m) => m.id === b.mechanic);
    if (!decl) continue;
    for (const action of ACTIONS[decl.type] ?? []) out.push(`${decl.id}.${action}`);
  }
  return out;
}

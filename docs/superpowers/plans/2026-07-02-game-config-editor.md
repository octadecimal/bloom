# Game Config Visual Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A studio pane plugin (`game-config`) that visually edits a game's slots@1 core config (symbols, reels, window, paylines, paytable, bonus) against the `slot_models` Mongo doc as single source of truth, with live save + socket re-hydration, replacing the simulator pane's raw JSON textarea.

**Architecture:** Pure-logic core (`model.ts`/`validate.ts`/`reducers.ts`, fully unit-tested) under a Hookstate plugin slice; debounced PUT to the existing `GET/PUT /games/{id}/slot-model` endpoints; a `slot_model_changed` socket event emitted from `SlotModelStore.put` (the single write choke point) drives external re-hydration. Frontend is built first (greenfield), backend diffs are additive and second, `SimulatorPane` slim-down is last.

**Tech Stack:** React + Hookstate + Dockview (existing studio frontend), vitest + Testing Library, FastAPI + Motor + python-socketio (existing backend), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-07-02-game-config-editor-design.md` (approved). Read it before starting any task.

## Global Constraints

- Work in the worktree `C:\code\bloom.wt\game-config` (branch `feat/game-config`, `BLOOM_PORT_OFFSET=3` → backend :8003, frontend :4203). Run `just bootstrap` once (npm install + uv sync). NEVER use ports :8000/:4200 — another session owns them.
- Semantic commits (`feat(game-config): …`, `test: …`); commit after every green task.
- TypeScript interfaces use the `I` prefix (`IPlugin`, `ISlotModel`).
- Design language is enforced by `studio/frontend/src/design-language.guard.spec.ts`: NO hex/rgb/hsl literals in any `.ts`/`.tsx` — raw colors go in `studio/frontend/src/styles.css` only. Use token utilities: `bg-canvas` / `bg-surface` / `bg-raised` / `bg-raised-hover`, `border-hairline` (`border-border`), `text-text-1/2/3`, `text-muted-foreground`, `text-success/warning/danger`, accent via `bg-primary` / `text-accent-text` (NOT `bg-accent` — that's intentionally neutral). One accent action per region.
- The SlotModel JSON uses the Rust serde wire shape: snake_case inner keys (`min_count`, `spins_awarded`, `feature_reels`), `SymbolRole` lowercase strings, `BonusFeature` externally tagged (`{"FreeSpins": {...}}`). Doc-level fields are camelCase on the wire (`gameId`, `updatedAt`, `presentation`).
- Reducers and validators are PURE — never mutate their input model; return new objects.
- Dynamic Tailwind class names do not compile. Every `bg-sym-N` class must appear as a full literal string (the `SWATCH_DOT_CLASS` map).
- `getHost()` throws before boot — call it lazily inside event handlers, never during render.
- Prettier is pinned: use `node_modules/.bin/prettier`, never `npx prettier`.
- Frontend gates before any push: `node_modules/.bin/prettier --check .`, `npx nx typecheck frontend`, `npx nx test frontend`, `npx nx build frontend`. Backend: `cd studio/backend && uv run pytest -m "not e2e" -q`.
- Shared-file discipline (concurrent session in simulator area): Tasks 1–13 touch only new files + 3 tiny additive edits (`styles.css`, `styles.tokens.spec.ts`, `plugins/index.ts`, `RoomRoute.tsx`). Tasks 14–15 make small additive backend edits. Task 16 (SimulatorPane) happens LAST, after `git fetch origin && git rebase origin/main`.

## File Structure

```
studio/frontend/src/plugins/game-config/
  model.ts + model.spec.ts              # ISlotModel types, emptyModel, normalizeModel
  presentation.ts + presentation.spec.ts# labels/swatches, IPresentation
  validate.ts + validate.spec.ts        # slots@1 invariants → IValidationIssue[]
  reducers.ts + reducers.spec.ts        # pure transforms + deriveStats
  config.ts                             # BACKEND_URL re-export
  state.ts                              # IGameConfigState + hooks/slice
  restClient.ts + restClient.spec.ts    # GET/PUT slot-model
  socketClient.ts                       # slot_model_changed subscription seam
  actions.ts + actions.spec.ts          # open/close, debounced save, external re-hydrate
  GameConfigPane.tsx + GameConfigPane.spec.tsx  # cockpit shell
  components/SymbolChip.tsx, Stepper.tsx, CommittedInput.tsx (+ CommittedInput.spec.tsx)
  sections/SymbolsSection.tsx, ReelsSection.tsx, PaylinesSection.tsx,
           PaytableSection.tsx, BonusSection.tsx, JsonSection.tsx (+ .spec.tsx each)
  index.ts                              # IPlugin registration
Modified:
  studio/frontend/src/styles.css                     (+ --sym-1..10 tokens, additive)
  studio/frontend/src/styles.tokens.spec.ts          (+ lock new tokens)
  studio/frontend/src/plugins/index.ts               (+ 2 lines)
  studio/frontend/src/app/routes/RoomRoute.tsx       (+ open/close wiring)
  studio/frontend/src/app/routes/RoomRoute.spec.tsx  (+ mock)
  studio/backend/app/simulator/models.py             (+ presentation field)
  studio/backend/app/simulator/store.py              (+ presentation/source/on_change)
  studio/backend/app/simulator/rest.py               (+ body fields)
  studio/backend/app/tuner/rest.py:61                (source="tuner")
  studio/backend/app/agent_tools.py:1461             (source="tuner")
  studio/backend/app/main.py                         (+ ~6 lines: on_change emitter)
  studio/backend/tests/test_sim_store.py, test_sim_rest.py (+ tests)
  studio/frontend/src/plugins/simulator/{SimulatorPane.tsx,state.ts,actions.ts,SimulatorPane.spec.tsx}  (LAST)
  studio/frontend/e2e/simulator.spec.ts              (rewrite: REST-seeded model)
  studio/frontend/e2e/game-config.spec.ts            (new)
```

All frontend unit-test commands run from `studio/frontend/`; backend from `studio/backend/`.

---

### Task 1: Model types + normalize (`model.ts`)

**Files:**

- Create: `studio/frontend/src/plugins/game-config/model.ts`
- Test: `studio/frontend/src/plugins/game-config/model.spec.ts`

**Interfaces:**

- Consumes: nothing (leaf module).
- Produces: `ISlotModel`, `ISymbolDef`, `SymbolRole`, `IPaytable`, `IPaytableEntry`, `IBonusFeature`, `IFreeSpinsConfig`, `ITriggerSpec`, `emptyModel(): ISlotModel`, `normalizeModel(raw: unknown): ISlotModel`. Every later task imports these types from `./model`.

- [ ] **Step 1: Write the failing test**

```ts
// studio/frontend/src/plugins/game-config/model.spec.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/plugins/game-config/model.spec.ts`
Expected: FAIL — `Cannot find module './model'` (or equivalent resolve error).

- [ ] **Step 3: Write the implementation**

```ts
// studio/frontend/src/plugins/game-config/model.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/plugins/game-config/model.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/game-config/model.ts studio/frontend/src/plugins/game-config/model.spec.ts
git commit -m "feat(game-config): slots@1 model types + normalizeModel"
```

---

### Task 2: Presentation helpers + `--sym-*` tokens

**Files:**

- Create: `studio/frontend/src/plugins/game-config/presentation.ts`
- Test: `studio/frontend/src/plugins/game-config/presentation.spec.ts`
- Modify: `studio/frontend/src/styles.css` (two additive blocks)
- Modify: `studio/frontend/src/styles.tokens.spec.ts` (lock new tokens)

**Interfaces:**

- Consumes: nothing.
- Produces: `IPresentation { symbols: Record<string, ISymbolPresentation> }`, `ISymbolPresentation { label: string; color: string }`, `emptyPresentation()`, `normalizePresentation(raw: unknown): IPresentation`, `SWATCHES: readonly string[]` (10 role names `'sym-1'…'sym-10'`), `SWATCH_DOT_CLASS: Record<string, string>` (role → literal Tailwind class), `symbolLabel(p, id): string`, `symbolColor(p, id): string`, `nextFreeSwatch(p): string`.

- [ ] **Step 1: Write the failing test**

```ts
// studio/frontend/src/plugins/game-config/presentation.spec.ts
import { describe, it, expect } from 'vitest';
import { SWATCHES, SWATCH_DOT_CLASS, emptyPresentation, normalizePresentation, symbolLabel, symbolColor, nextFreeSwatch } from './presentation';

describe('swatches', () => {
  it('defines 10 swatch roles each with a literal dot class', () => {
    expect(SWATCHES).toHaveLength(10);
    for (const s of SWATCHES) expect(SWATCH_DOT_CLASS[s]).toBe(`bg-${s}`);
  });
});

describe('symbolLabel / symbolColor fallbacks', () => {
  it('uses the stored entry when present', () => {
    const p = { symbols: { '0': { label: 'Ace', color: 'sym-3' } } };
    expect(symbolLabel(p, 0)).toBe('Ace');
    expect(symbolColor(p, 0)).toBe('sym-3');
  });

  it('falls back to S<id> and a deterministic swatch', () => {
    const p = emptyPresentation();
    expect(symbolLabel(p, 7)).toBe('S7');
    expect(symbolColor(p, 7)).toBe(SWATCHES[7 % 10]);
    expect(symbolColor(p, 12)).toBe(SWATCHES[12 % 10]);
  });
});

describe('nextFreeSwatch', () => {
  it('picks the first swatch not used by any entry', () => {
    const p = { symbols: { '0': { label: 'A', color: 'sym-1' }, '1': { label: 'B', color: 'sym-2' } } };
    expect(nextFreeSwatch(p)).toBe('sym-3');
  });

  it('wraps to sym-1 when all are used', () => {
    const symbols: Record<string, { label: string; color: string }> = {};
    SWATCHES.forEach((s, i) => (symbols[String(i)] = { label: `S${i}`, color: s }));
    expect(nextFreeSwatch({ symbols })).toBe('sym-1');
  });
});

describe('normalizePresentation', () => {
  it('defaults missing/malformed input to empty', () => {
    expect(normalizePresentation(undefined)).toEqual({ symbols: {} });
    expect(normalizePresentation({ symbols: 5 })).toEqual({ symbols: {} });
  });
  it('passes a good map through', () => {
    const p = { symbols: { '2': { label: 'Wild', color: 'sym-4' } } };
    expect(normalizePresentation(p)).toEqual(p);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/plugins/game-config/presentation.spec.ts`
Expected: FAIL — cannot resolve `./presentation`.

- [ ] **Step 3: Write the implementation**

```ts
// studio/frontend/src/plugins/game-config/presentation.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/plugins/game-config/presentation.spec.ts`
Expected: PASS.

- [ ] **Step 5: Add the `--sym-*` tokens to `styles.css`**

In `studio/frontend/src/styles.css`, inside the `:root` block, directly AFTER the `/* Status */` group (`--danger: #f0574d;` line), add:

```css
/* Symbol swatches — game-config editor chip dots. Muted categorical ramp for dark UI. */
--sym-1: #e2635a;
--sym-2: #e5924c;
--sym-3: #d4b04e;
--sym-4: #87b860;
--sym-5: #46b0a1;
--sym-6: #57a8d8;
--sym-7: #7d8fe8;
--sym-8: #a97fe0;
--sym-9: #d873b8;
--sym-10: #9aa2ad;
```

In the `@theme inline` block, after `--color-danger: var(--danger);`, add:

```css
--color-sym-1: var(--sym-1);
--color-sym-2: var(--sym-2);
--color-sym-3: var(--sym-3);
--color-sym-4: var(--sym-4);
--color-sym-5: var(--sym-5);
--color-sym-6: var(--sym-6);
--color-sym-7: var(--sym-7);
--color-sym-8: var(--sym-8);
--color-sym-9: var(--sym-9);
--color-sym-10: var(--sym-10);
```

- [ ] **Step 6: Lock the tokens in `styles.tokens.spec.ts`**

Add to the `EXPECTED` record in `studio/frontend/src/styles.tokens.spec.ts` (after `'--danger': '#f0574d',`):

```ts
  '--sym-1': '#e2635a',
  '--sym-2': '#e5924c',
  '--sym-3': '#d4b04e',
  '--sym-4': '#87b860',
  '--sym-5': '#46b0a1',
  '--sym-6': '#57a8d8',
  '--sym-7': '#7d8fe8',
  '--sym-8': '#a97fe0',
  '--sym-9': '#d873b8',
  '--sym-10': '#9aa2ad',
```

- [ ] **Step 7: Run the token + guard suites**

Run: `npx vitest run src/styles.tokens.spec.ts src/design-language.guard.spec.ts`
Expected: PASS (guard passes because the hexes live only in `styles.css`).

- [ ] **Step 8: Commit**

```bash
git add studio/frontend/src/plugins/game-config/presentation.ts studio/frontend/src/plugins/game-config/presentation.spec.ts studio/frontend/src/styles.css studio/frontend/src/styles.tokens.spec.ts
git commit -m "feat(game-config): symbol presentation helpers + --sym-* swatch tokens"
```

---

### Task 3: Validation (`validate.ts`)

**Files:**

- Create: `studio/frontend/src/plugins/game-config/validate.ts`
- Test: `studio/frontend/src/plugins/game-config/validate.spec.ts`

**Interfaces:**

- Consumes: `ISlotModel` from `./model`.
- Produces: `GcTab = 'symbols' | 'reels' | 'paylines' | 'paytable' | 'bonus' | 'json'`, `IValidationIssue { tab: GcTab; path: string; severity: 'error' | 'warning'; message: string }`, `validateModel(m: ISlotModel): IValidationIssue[]`. The pane shell (Task 8) filters issues by `tab` for warning dots; sections match by `path` prefix for inline messages.

`path` convention: `symbols[i]`, `reels[r]`, `rows`, `paylines[i]`, `paytable.entries[i]`, `bonuses[b]`, `bonuses[b].feature_reels[r]`.

- [ ] **Step 1: Write the failing test**

```ts
// studio/frontend/src/plugins/game-config/validate.spec.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/plugins/game-config/validate.spec.ts`
Expected: FAIL — cannot resolve `./validate`.

- [ ] **Step 3: Write the implementation**

```ts
// studio/frontend/src/plugins/game-config/validate.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/plugins/game-config/validate.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/game-config/validate.ts studio/frontend/src/plugins/game-config/validate.spec.ts
git commit -m "feat(game-config): client-side slots@1 validation"
```

---

### Task 4: Pure transforms + stats (`reducers.ts`)

**Files:**

- Create: `studio/frontend/src/plugins/game-config/reducers.ts`
- Test: `studio/frontend/src/plugins/game-config/reducers.spec.ts`

**Interfaces:**

- Consumes: `ISlotModel`, `IPaytableEntry`, `ITriggerSpec`, `IFreeSpinsConfig`, `SymbolRole` from `./model`.
- Produces (all pure `(m: ISlotModel, …) => ISlotModel` unless noted):
  - `ReelSetRef = 'base' | number` (number = bonus index)
  - `getStrips(m, ref): number[][] | null` (null when the bonus has no feature reels)
  - `countOccurrences(strip: number[], symbol: number): number`
  - `addSymbol(m)`, `removeSymbol(m, id)`, `setSymbolRole(m, id, role)`
  - `insertStripCell(m, ref, reel, index, symbol)`, `replaceStripCell(m, ref, reel, index, symbol)`, `removeStripCell(m, ref, reel, index)`, `moveStripCell(m, ref, reel, from, to)`, `appendStripCell(m, ref, reel, symbol)`
  - `setSymbolCount(m, ref, reel, symbol, count)` — append on increment, remove LAST occurrences on decrement
  - `setRows(m, rows)`, `setReelCount(m, count)` — resizes base strips, every payline (pad row 0 / truncate), and every non-null `feature_reels`
  - `addFeatureReels(m, bonusIndex)` (clones base), `clearFeatureReels(m, bonusIndex)`
  - `addPayline(m)`, `duplicatePayline(m, i)`, `removePayline(m, i)`, `setPaylineCell(m, i, reel, row)`
  - `addPaytableRow(m, symbol)` (defaults `count: 3, payout: 0`), `updatePaytableRow(m, i, patch: Partial<IPaytableEntry>)`, `removePaytableRow(m, i)`
  - `addBonus(m)` (trigger defaults to first scatter or 0, `min_count: 3`, `spins_awarded: 5`, `retrigger: false`, `multiplier: 1`, `feature_reels: null`), `removeBonus(m, i)`, `updateBonusTrigger(m, i, patch: Partial<ITriggerSpec>)`, `updateBonusConfig(m, i, patch: Partial<Omit<IFreeSpinsConfig, 'feature_reels'>>)`
  - `deriveStats(m): IModelStats { rows; reelCount; symbolCount; paylineCount; stripLengths: number[] }`

- [ ] **Step 1: Write the failing test**

```ts
// studio/frontend/src/plugins/game-config/reducers.spec.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/plugins/game-config/reducers.spec.ts`
Expected: FAIL — cannot resolve `./reducers`.

- [ ] **Step 3: Write the implementation**

```ts
// studio/frontend/src/plugins/game-config/reducers.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/plugins/game-config/reducers.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/game-config/reducers.ts studio/frontend/src/plugins/game-config/reducers.spec.ts
git commit -m "feat(game-config): pure model transforms + deriveStats"
```

---

### Task 5: State slice + REST client (`state.ts`, `config.ts`, `restClient.ts`)

**Files:**

- Create: `studio/frontend/src/plugins/game-config/config.ts`
- Create: `studio/frontend/src/plugins/game-config/state.ts`
- Create: `studio/frontend/src/plugins/game-config/restClient.ts`
- Test: `studio/frontend/src/plugins/game-config/restClient.spec.ts`

**Interfaces:**

- Consumes: `ISlotModel` (`./model`), `IPresentation` (`./presentation`), `GcTab` (`./validate`), `ReelSetRef` (`./reducers`), `makePluginHooks` (`../../state/makePluginHooks`), `rootStore` (`../../state/rootStore`).
- Produces:
  - `GAME_CONFIG_PLUGIN_ID = 'game-config'`
  - `GcLens = 'strip' | 'composition'`, `GcSync = 'idle' | 'saving' | 'saved' | 'external' | 'error'`
  - `IGameConfigState { activeGameId: string | null; model: ISlotModel | null; presentation: IPresentation; jsonDraft: string; jsonError: string | null; activeTab: GcTab; reelLens: GcLens; activeReelSet: ReelSetRef; sync: GcSync; externalSource: string | null; watermark: string; loadStatus: 'idle' | 'loading' | 'error' }`
  - `makeInitialState(): IGameConfigState`, `gameConfigHooks`, `gameConfigSlice(): State<IGameConfigState>`
  - `ISlotModelWireDoc { id: string; gameId: string; model: unknown; presentation?: unknown; updatedAt: string }`
  - `getSlotModel(gameId): Promise<ISlotModelWireDoc>`, `putSlotModel(gameId, patch: { model?: ISlotModel; presentation?: IPresentation; source: string }): Promise<ISlotModelWireDoc>`

- [ ] **Step 1: Write `config.ts` and `state.ts`** (no behavior — types + slice, covered by later specs)

```ts
// studio/frontend/src/plugins/game-config/config.ts
export { BACKEND_URL } from '../assets/config';
```

```ts
// studio/frontend/src/plugins/game-config/state.ts
import type { State } from '@hookstate/core';
import { rootStore } from '../../state/rootStore';
import { makePluginHooks } from '../../state/makePluginHooks';
import type { ISlotModel } from './model';
import { emptyPresentation, type IPresentation } from './presentation';
import type { GcTab } from './validate';
import type { ReelSetRef } from './reducers';

export const GAME_CONFIG_PLUGIN_ID = 'game-config';

export type GcLens = 'strip' | 'composition';
export type GcSync = 'idle' | 'saving' | 'saved' | 'external' | 'error';

export interface IGameConfigState {
  activeGameId: string | null;
  model: ISlotModel | null;
  presentation: IPresentation;
  jsonDraft: string;
  jsonError: string | null;
  activeTab: GcTab;
  reelLens: GcLens;
  activeReelSet: ReelSetRef;
  sync: GcSync;
  externalSource: string | null;
  watermark: string; // updatedAt of the last state we hydrated; older socket events are ignored
  loadStatus: 'idle' | 'loading' | 'error';
}

export function makeInitialState(): IGameConfigState {
  return {
    activeGameId: null,
    model: null,
    presentation: emptyPresentation(),
    jsonDraft: '',
    jsonError: null,
    activeTab: 'symbols',
    reelLens: 'strip',
    activeReelSet: 'base',
    sync: 'idle',
    externalSource: null,
    watermark: '',
    loadStatus: 'idle',
  };
}

export const gameConfigHooks = makePluginHooks<IGameConfigState>(GAME_CONFIG_PLUGIN_ID);

export function gameConfigSlice(): State<IGameConfigState> {
  return rootStore.plugins.nested(GAME_CONFIG_PLUGIN_ID) as unknown as State<IGameConfigState>;
}
```

- [ ] **Step 2: Write the failing REST client test**

```ts
// studio/frontend/src/plugins/game-config/restClient.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSlotModel, putSlotModel } from './restClient';
import { BACKEND_URL } from './config';

const okResponse = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

describe('game-config restClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('getSlotModel GETs the doc', async () => {
    const doc = { id: 'd1', gameId: 'g1', model: {}, updatedAt: 't1' };
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(doc));
    expect(await getSlotModel('g1')).toEqual(doc);
    expect(spy).toHaveBeenCalledWith(`${BACKEND_URL}/games/g1/slot-model`);
  });

  it('putSlotModel PUTs only the provided fields plus source', async () => {
    const doc = { id: 'd1', gameId: 'g1', model: { rows: 3 }, updatedAt: 't2' };
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(doc));
    await putSlotModel('g1', { presentation: { symbols: {} }, source: 'editor' });
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BACKEND_URL}/games/g1/slot-model`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ presentation: { symbols: {} }, source: 'editor' });
  });

  it('throws on a non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500 } as Response);
    await expect(getSlotModel('g1')).rejects.toThrow('request failed: 500');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/plugins/game-config/restClient.spec.ts`
Expected: FAIL — cannot resolve `./restClient`.

- [ ] **Step 4: Write the implementation**

```ts
// studio/frontend/src/plugins/game-config/restClient.ts
import { BACKEND_URL } from './config';
import type { ISlotModel } from './model';
import type { IPresentation } from './presentation';

export interface ISlotModelWireDoc {
  id: string;
  gameId: string;
  model: unknown;
  presentation?: unknown; // absent until the backend task lands; normalized on hydrate
  updatedAt: string;
}

async function okJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function getSlotModel(gameId: string): Promise<ISlotModelWireDoc> {
  return okJson<ISlotModelWireDoc>(await fetch(`${BACKEND_URL}/games/${gameId}/slot-model`));
}

export async function putSlotModel(gameId: string, patch: { model?: ISlotModel; presentation?: IPresentation; source: string }): Promise<ISlotModelWireDoc> {
  return okJson<ISlotModelWireDoc>(
    await fetch(`${BACKEND_URL}/games/${gameId}/slot-model`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/plugins/game-config/restClient.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/plugins/game-config/config.ts studio/frontend/src/plugins/game-config/state.ts studio/frontend/src/plugins/game-config/restClient.ts studio/frontend/src/plugins/game-config/restClient.spec.ts
git commit -m "feat(game-config): plugin state slice + slot-model REST client"
```

---

### Task 6: Actions + socket sync (`actions.ts`, `socketClient.ts`)

**Files:**

- Create: `studio/frontend/src/plugins/game-config/socketClient.ts`
- Create: `studio/frontend/src/plugins/game-config/actions.ts`
- Test: `studio/frontend/src/plugins/game-config/actions.spec.ts`

**Interfaces:**

- Consumes: `gameConfigSlice`, `makeInitialState` (`./state`), `getSlotModel`/`putSlotModel` (`./restClient`), `normalizeModel` (`./model`), `normalizePresentation` (`./presentation`).
- Produces:
  - socketClient: `createGameConfigSocket()` → `{ connect(), disconnect(), join(gameId), leave(gameId) }` (joins the game room via the EXISTING `join_sim` / `leave_sim` handlers — the room IS the gameId), `gameConfigSock()` singleton, `setModelChangedHandler(h: (p: IModelChangedEvent) => void)`, `IModelChangedEvent { gameId: string; updatedAt: string; source: string }`. The socket listens for `slot_model_changed` and delegates to the registered handler (a seam that avoids an actions↔socket import cycle and makes the handler unit-testable without a socket).
  - actions: `SAVE_DEBOUNCE_MS = 600`, `EXTERNAL_FLASH_MS = 4000`, `initGameConfig()`, `openGameConfig(gameId)`, `closeGameConfig()`, `applyModel(fn: (m: ISlotModel) => ISlotModel)`, `applyPresentation(fn: (p: IPresentation) => IPresentation)`, `applyModelFromJson(text: string): boolean`, `flushPendingSave(): Promise<void>`, `handleModelChanged(p: IModelChangedEvent)`.

Behavioral contract (encoded in the tests below):

- `applyModel` sets `model` + refreshes `jsonDraft`, marks `sync='saving'`, and debounces one PUT (600 ms) with `source: 'editor'`; burst edits collapse into one PUT carrying the latest state.
- `applyPresentation` likewise but PUTs `presentation`.
- A successful PUT advances `watermark` to the response `updatedAt` and sets `sync='saved'`; a failed PUT sets `sync='error'`.
- `handleModelChanged`: not-active game → ignore. `source==='editor'` → only advance watermark. External source with `updatedAt <= watermark` → ignore (out-of-order delivery). External + newer → GET the doc, replace `model`/`presentation`/`jsonDraft`, advance watermark, `sync='external'` + `externalSource`, and after `EXTERNAL_FLASH_MS` fall back to `'saved'`.
- `applyModelFromJson`: parse failure → set `jsonError`, return false, save nothing; success → clear `jsonError`, run through `normalizeModel`, behave like `applyModel`.

- [ ] **Step 1: Write the failing actions test**

```ts
// studio/frontend/src/plugins/game-config/actions.spec.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { GAME_CONFIG_PLUGIN_ID, gameConfigSlice, makeInitialState } from './state';
import type { ISlotModel } from './model';

const putSlotModel = vi.fn();
const getSlotModel = vi.fn();
vi.mock('./restClient', () => ({
  putSlotModel: (...a: unknown[]) => putSlotModel(...a),
  getSlotModel: (...a: unknown[]) => getSlotModel(...a),
}));
vi.mock('./socketClient', () => ({
  gameConfigSock: () => ({ connect: vi.fn(), disconnect: vi.fn(), join: vi.fn(), leave: vi.fn() }),
  setModelChangedHandler: vi.fn(),
}));

import {
  SAVE_DEBOUNCE_MS,
  EXTERNAL_FLASH_MS,
  openGameConfig,
  applyModel,
  applyPresentation,
  applyModelFromJson,
  flushPendingSave,
  handleModelChanged,
} from './actions';

const MODEL: ISlotModel = {
  symbols: [{ id: 0, role: 'normal' }],
  reels: [[0, 0]],
  rows: 1,
  paylines: [[0]],
  paytable: { entries: [] },
  bonuses: [],
};

function doc(model: unknown, updatedAt: string, presentation: unknown = { symbols: {} }) {
  return { id: 'd1', gameId: 'g1', model, presentation, updatedAt };
}

describe('game-config actions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    putSlotModel.mockReset();
    getSlotModel.mockReset();
    rootStore.plugins.nested(GAME_CONFIG_PLUGIN_ID).set(makeInitialState() as never);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function open() {
    getSlotModel.mockResolvedValue(doc(MODEL, 't1'));
    await openGameConfig('g1');
  }

  it('openGameConfig hydrates model, presentation, jsonDraft and watermark', async () => {
    await open();
    const s = gameConfigSlice();
    expect(s.activeGameId.get()).toBe('g1');
    expect(s.model.get({ noproxy: true })).toEqual(MODEL);
    expect(s.watermark.get()).toBe('t1');
    expect(JSON.parse(s.jsonDraft.get())).toEqual(MODEL);
  });

  it('applyModel debounces a single PUT with source editor and marks saved', async () => {
    await open();
    putSlotModel.mockResolvedValue(doc(MODEL, 't2'));
    applyModel((m) => ({ ...m, rows: 2 }));
    applyModel((m) => ({ ...m, rows: 4 }));
    expect(gameConfigSlice().sync.get()).toBe('saving');
    expect(putSlotModel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 10);
    expect(putSlotModel).toHaveBeenCalledTimes(1);
    const [gameId, patch] = putSlotModel.mock.calls[0];
    expect(gameId).toBe('g1');
    expect(patch.source).toBe('editor');
    expect(patch.model.rows).toBe(4);
    expect(patch.presentation).toBeUndefined();
    expect(gameConfigSlice().sync.get()).toBe('saved');
    expect(gameConfigSlice().watermark.get()).toBe('t2');
  });

  it('applyPresentation PUTs presentation only', async () => {
    await open();
    putSlotModel.mockResolvedValue(doc(MODEL, 't2'));
    applyPresentation((p) => ({ symbols: { ...p.symbols, '0': { label: 'Ace', color: 'sym-1' } } }));
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 10);
    const [, patch] = putSlotModel.mock.calls[0];
    expect(patch.model).toBeUndefined();
    expect(patch.presentation.symbols['0'].label).toBe('Ace');
  });

  it('a failed PUT sets sync=error', async () => {
    await open();
    putSlotModel.mockRejectedValue(new Error('boom'));
    applyModel((m) => ({ ...m, rows: 2 }));
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 10);
    expect(gameConfigSlice().sync.get()).toBe('error');
  });

  it('applyModelFromJson: invalid JSON sets jsonError and saves nothing', async () => {
    await open();
    expect(applyModelFromJson('not json')).toBe(false);
    expect(gameConfigSlice().jsonError.get()).toBeTruthy();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 10);
    expect(putSlotModel).not.toHaveBeenCalled();
  });

  it('applyModelFromJson: valid JSON replaces the model and saves', async () => {
    await open();
    putSlotModel.mockResolvedValue(doc(MODEL, 't2'));
    expect(applyModelFromJson(JSON.stringify({ ...MODEL, rows: 7 }))).toBe(true);
    expect(gameConfigSlice().jsonError.get()).toBeNull();
    expect(gameConfigSlice().model.rows.get()).toBe(7);
    await flushPendingSave();
    expect(putSlotModel).toHaveBeenCalledTimes(1);
  });

  it('handleModelChanged ignores own editor echo (watermark only)', async () => {
    await open();
    handleModelChanged({ gameId: 'g1', updatedAt: 't5', source: 'editor' });
    expect(gameConfigSlice().watermark.get()).toBe('t5');
    expect(getSlotModel).toHaveBeenCalledTimes(1); // only the open() call
  });

  it('handleModelChanged ignores stale external events', async () => {
    await open();
    handleModelChanged({ gameId: 'g1', updatedAt: 't0', source: 'tuner' });
    expect(getSlotModel).toHaveBeenCalledTimes(1);
  });

  it('handleModelChanged re-hydrates on a newer external write and flashes external', async () => {
    await open();
    const external = { ...MODEL, rows: 9 };
    getSlotModel.mockResolvedValue(doc(external, 't9'));
    handleModelChanged({ gameId: 'g1', updatedAt: 't9', source: 'tuner' });
    await vi.advanceTimersByTimeAsync(1); // let the async re-hydrate resolve
    const s = gameConfigSlice();
    expect(s.model.rows.get()).toBe(9);
    expect(s.watermark.get()).toBe('t9');
    expect(s.sync.get()).toBe('external');
    expect(s.externalSource.get()).toBe('tuner');
    await vi.advanceTimersByTimeAsync(EXTERNAL_FLASH_MS + 10);
    expect(s.sync.get()).toBe('saved');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/plugins/game-config/actions.spec.ts`
Expected: FAIL — cannot resolve `./actions` / `./socketClient`.

- [ ] **Step 3: Write `socketClient.ts`**

```ts
// studio/frontend/src/plugins/game-config/socketClient.ts
// Joins the game's socket room via the EXISTING join_sim/leave_sim handlers (the room
// is the gameId) and listens for slot_model_changed. The handler is injected by
// actions.initGameConfig() — a seam that avoids an import cycle and eases testing.
import { io, type Socket } from 'socket.io-client';
import { BACKEND_URL } from './config';

export interface IModelChangedEvent {
  gameId: string;
  updatedAt: string;
  source: string;
}

let handler: ((p: IModelChangedEvent) => void) | null = null;

export function setModelChangedHandler(h: (p: IModelChangedEvent) => void): void {
  handler = h;
}

let sock: Socket | null = null;

export function createGameConfigSocket() {
  function connect(): void {
    if (sock) return;
    sock = io(BACKEND_URL, { auth: { displayName: 'game-config' } });
    sock.on('slot_model_changed', (p: IModelChangedEvent) => handler?.(p));
  }
  function disconnect(): void {
    sock?.disconnect();
    sock = null;
  }
  return {
    connect,
    disconnect,
    join: (gameId: string) => sock?.emit('join_sim', { gameId }),
    leave: (gameId: string) => sock?.emit('leave_sim', { gameId }),
  };
}

let client: ReturnType<typeof createGameConfigSocket> | null = null;
export function gameConfigSock() {
  if (!client) client = createGameConfigSocket();
  return client;
}
```

- [ ] **Step 4: Write `actions.ts`**

```ts
// studio/frontend/src/plugins/game-config/actions.ts
import { gameConfigSlice } from './state';
import { getSlotModel, putSlotModel, type ISlotModelWireDoc } from './restClient';
import { normalizeModel, type ISlotModel } from './model';
import { normalizePresentation, type IPresentation } from './presentation';
import { gameConfigSock, setModelChangedHandler, type IModelChangedEvent } from './socketClient';

export const SAVE_DEBOUNCE_MS = 600;
export const EXTERNAL_FLASH_MS = 4000;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let flashTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = { model: false, presentation: false };

export function initGameConfig(): void {
  gameConfigSock().connect();
  setModelChangedHandler(handleModelChanged);
}

function hydrateDoc(doc: ISlotModelWireDoc): void {
  const s = gameConfigSlice();
  const model = normalizeModel(doc.model);
  s.model.set(model);
  s.presentation.set(normalizePresentation(doc.presentation));
  s.jsonDraft.set(JSON.stringify(model, null, 2));
  s.jsonError.set(null);
  if (doc.updatedAt > s.watermark.get()) s.watermark.set(doc.updatedAt);
}

export async function openGameConfig(gameId: string): Promise<void> {
  const s = gameConfigSlice();
  s.activeGameId.set(gameId);
  s.loadStatus.set('loading');
  gameConfigSock().join(gameId);
  try {
    hydrateDoc(await getSlotModel(gameId));
    s.loadStatus.set('idle');
  } catch {
    s.loadStatus.set('error');
  }
}

export function closeGameConfig(): void {
  const s = gameConfigSlice();
  const prev = s.activeGameId.get();
  if (prev) gameConfigSock().leave(prev);
  if (saveTimer) clearTimeout(saveTimer);
  if (flashTimer) clearTimeout(flashTimer);
  saveTimer = null;
  flashTimer = null;
  dirty = { model: false, presentation: false };
  s.activeGameId.set(null);
  s.model.set(null);
  s.presentation.set({ symbols: {} });
  s.jsonDraft.set('');
  s.jsonError.set(null);
  s.sync.set('idle');
  s.externalSource.set(null);
  s.watermark.set('');
  s.loadStatus.set('idle');
}

function scheduleSave(kind: 'model' | 'presentation'): void {
  dirty[kind] = true;
  gameConfigSlice().sync.set('saving');
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushPendingSave(), SAVE_DEBOUNCE_MS);
}

export async function flushPendingSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const s = gameConfigSlice();
  const gameId = s.activeGameId.get();
  if (!gameId || (!dirty.model && !dirty.presentation)) return;
  const patch: { model?: ISlotModel; presentation?: IPresentation; source: string } = { source: 'editor' };
  if (dirty.model) patch.model = s.model.get({ noproxy: true }) as ISlotModel;
  if (dirty.presentation) patch.presentation = s.presentation.get({ noproxy: true }) as IPresentation;
  dirty = { model: false, presentation: false };
  try {
    const doc = await putSlotModel(gameId, patch);
    if (doc.updatedAt > s.watermark.get()) s.watermark.set(doc.updatedAt);
    if (s.sync.get() === 'saving') s.sync.set('saved');
  } catch {
    s.sync.set('error');
  }
}

export function applyModel(fn: (m: ISlotModel) => ISlotModel): void {
  const s = gameConfigSlice();
  const current = s.model.get({ noproxy: true }) as ISlotModel | null;
  if (!current) return;
  const next = fn(current);
  s.model.set(next);
  s.jsonDraft.set(JSON.stringify(next, null, 2));
  scheduleSave('model');
}

export function applyPresentation(fn: (p: IPresentation) => IPresentation): void {
  const s = gameConfigSlice();
  const next = fn(s.presentation.get({ noproxy: true }) as IPresentation);
  s.presentation.set(next);
  scheduleSave('presentation');
}

/** JSON tab Apply. Returns false (and sets jsonError) on a parse failure. */
export function applyModelFromJson(text: string): boolean {
  const s = gameConfigSlice();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    s.jsonError.set(e instanceof Error ? e.message : 'invalid JSON');
    return false;
  }
  s.jsonError.set(null);
  applyModel(() => normalizeModel(parsed));
  return true;
}

export function handleModelChanged(p: IModelChangedEvent): void {
  const s = gameConfigSlice();
  if (s.activeGameId.get() !== p.gameId) return;
  if (p.source === 'editor') {
    if (p.updatedAt > s.watermark.get()) s.watermark.set(p.updatedAt);
    return;
  }
  if (p.updatedAt <= s.watermark.get()) return;
  void rehydrateExternal(p.source);
}

async function rehydrateExternal(source: string): Promise<void> {
  const s = gameConfigSlice();
  const gameId = s.activeGameId.get();
  if (!gameId) return;
  try {
    hydrateDoc(await getSlotModel(gameId));
  } catch {
    return; // transient fetch failure: keep current state
  }
  s.sync.set('external');
  s.externalSource.set(source);
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    if (gameConfigSlice().sync.get() === 'external') gameConfigSlice().sync.set('saved');
  }, EXTERNAL_FLASH_MS);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/plugins/game-config/actions.spec.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/plugins/game-config/actions.ts studio/frontend/src/plugins/game-config/actions.spec.ts studio/frontend/src/plugins/game-config/socketClient.ts
git commit -m "feat(game-config): debounced live-save actions + slot_model_changed sync"
```

---

### Task 7: Shared UI atoms (`SymbolChip`, `Stepper`, `CommittedInput`)

**Files:**

- Create: `studio/frontend/src/plugins/game-config/components/SymbolChip.tsx`
- Create: `studio/frontend/src/plugins/game-config/components/Stepper.tsx`
- Create: `studio/frontend/src/plugins/game-config/components/CommittedInput.tsx`
- Test: `studio/frontend/src/plugins/game-config/components/CommittedInput.spec.tsx`

**Interfaces:**

- Consumes: `IPresentation`, `symbolLabel`, `symbolColor`, `SWATCH_DOT_CLASS` (`../presentation`).
- Produces:
  - `SymbolChip({ presentation, id, testId? })` — raised pill with swatch dot + label.
  - `Stepper({ value, onChange, min?, max?, testId })` — `[-] value [+]` control; renders `data-testid={testId}` on the value, `` `${testId}-inc` ``/`` `${testId}-dec` `` on the buttons.
  - `CommittedInput({ value, onCommit, kind, testId, className?, placeholder? })` with `kind: 'text' | 'int'` — the focused-field guard: while focused it shows a local draft (external re-hydration cannot clobber typing); on blur or Enter it commits via `onCommit` (int kind parses and rejects non-integers by reverting).

- [ ] **Step 1: Write the failing CommittedInput test**

```tsx
// studio/frontend/src/plugins/game-config/components/CommittedInput.spec.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommittedInput } from './CommittedInput';

describe('CommittedInput', () => {
  it('commits the draft on blur', () => {
    const onCommit = vi.fn();
    render(<CommittedInput value="Ace" onCommit={onCommit} kind="text" testId="in" />);
    const el = screen.getByTestId('in') as HTMLInputElement;
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: 'King' } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(el);
    expect(onCommit).toHaveBeenCalledWith('King');
  });

  it('keeps the local draft while focused even if the value prop changes (external write guard)', () => {
    const onCommit = vi.fn();
    const { rerender } = render(<CommittedInput value="Ace" onCommit={onCommit} kind="text" testId="in" />);
    const el = screen.getByTestId('in') as HTMLInputElement;
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: 'Ki' } });
    rerender(<CommittedInput value="Tuned" onCommit={onCommit} kind="text" testId="in" />);
    expect(el.value).toBe('Ki'); // draft survives the external re-hydration
    fireEvent.blur(el);
    expect(onCommit).toHaveBeenCalledWith('Ki'); // this field's value wins for this field only
  });

  it('shows the new prop value when not focused', () => {
    const { rerender } = render(<CommittedInput value="Ace" onCommit={vi.fn()} kind="text" testId="in" />);
    rerender(<CommittedInput value="Tuned" onCommit={vi.fn()} kind="text" testId="in" />);
    expect((screen.getByTestId('in') as HTMLInputElement).value).toBe('Tuned');
  });

  it('int kind commits parsed integers and reverts on garbage', () => {
    const onCommit = vi.fn();
    render(<CommittedInput value="5" onCommit={onCommit} kind="int" testId="in" />);
    const el = screen.getByTestId('in') as HTMLInputElement;
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: '12' } });
    fireEvent.blur(el);
    expect(onCommit).toHaveBeenCalledWith('12');
    onCommit.mockReset();
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: 'xyz' } });
    fireEvent.blur(el);
    expect(onCommit).not.toHaveBeenCalled();
    expect(el.value).toBe('5'); // reverted
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/plugins/game-config/components/CommittedInput.spec.tsx`
Expected: FAIL — cannot resolve `./CommittedInput`.

- [ ] **Step 3: Write the three components**

```tsx
// studio/frontend/src/plugins/game-config/components/CommittedInput.tsx
import { useState } from 'react';

export interface ICommittedInputProps {
  value: string;
  onCommit: (value: string) => void;
  kind: 'text' | 'int';
  testId: string;
  className?: string;
  placeholder?: string;
}

/** Input that holds a local draft while focused and commits on blur/Enter.
 *  This IS the spec's focused-field guard: an external re-hydration replaces the
 *  state behind `value`, but the focused field keeps its draft until blur. */
export function CommittedInput({ value, onCommit, kind, testId, className, placeholder }: ICommittedInputProps) {
  const [draft, setDraft] = useState<string | null>(null);

  function commit(): void {
    if (draft === null) return;
    const next = draft;
    setDraft(null);
    if (next === value) return;
    if (kind === 'int' && !/^-?\d+$/.test(next.trim())) return; // revert garbage
    onCommit(kind === 'int' ? String(parseInt(next.trim(), 10)) : next);
  }

  return (
    <input
      data-testid={testId}
      value={draft ?? value}
      placeholder={placeholder}
      spellCheck={false}
      inputMode={kind === 'int' ? 'numeric' : undefined}
      onFocus={() => setDraft(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      className={className ?? 'h-6 rounded border border-border bg-canvas px-1.5 text-xs text-text-1 outline-none focus-visible:ring-2 focus-visible:ring-ring'}
    />
  );
}
```

```tsx
// studio/frontend/src/plugins/game-config/components/Stepper.tsx
export interface IStepperProps {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  testId: string;
}

export function Stepper({ value, onChange, min = 0, max = Number.MAX_SAFE_INTEGER, testId }: IStepperProps) {
  const dec = () => value > min && onChange(value - 1);
  const inc = () => value < max && onChange(value + 1);
  const btn = 'h-5 w-5 rounded border border-border text-xs text-text-2 hover:bg-raised-hover disabled:text-text-3';
  return (
    <span className="inline-flex items-center gap-1">
      <button data-testid={`${testId}-dec`} className={btn} onClick={dec} disabled={value <= min}>
        −
      </button>
      <span data-testid={testId} className="min-w-6 text-center font-mono text-xs text-text-1">
        {value}
      </span>
      <button data-testid={`${testId}-inc`} className={btn} onClick={inc} disabled={value >= max}>
        +
      </button>
    </span>
  );
}
```

```tsx
// studio/frontend/src/plugins/game-config/components/SymbolChip.tsx
import { symbolColor, symbolLabel, SWATCH_DOT_CLASS, type IPresentation } from '../presentation';

export interface ISymbolChipProps {
  presentation: IPresentation;
  id: number;
  testId?: string;
}

/** StatusPill-style chip: swatch dot + label. Dot color comes from the token map —
 *  never a raw color (design-language guard). */
export function SymbolChip({ presentation, id, testId }: ISymbolChipProps) {
  const color = symbolColor(presentation, id);
  return (
    <span data-testid={testId} className="inline-flex items-center gap-1.5 rounded-full bg-raised px-2 py-0.5 text-[11px] text-text-1">
      <span className={`h-1.5 w-1.5 rounded-full ${SWATCH_DOT_CLASS[color] ?? 'bg-muted-foreground'}`} />
      {symbolLabel(presentation, id)}
    </span>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/plugins/game-config/components/CommittedInput.spec.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/game-config/components
git commit -m "feat(game-config): shared UI atoms (SymbolChip, Stepper, CommittedInput)"
```

---

### Task 8: Pane shell + plugin registration + room wiring

**Files:**

- Create: `studio/frontend/src/plugins/game-config/GameConfigPane.tsx`
- Create: `studio/frontend/src/plugins/game-config/index.ts`
- Create: 6 stub sections `studio/frontend/src/plugins/game-config/sections/{SymbolsSection,ReelsSection,PaylinesSection,PaytableSection,BonusSection,JsonSection}.tsx`
- Test: `studio/frontend/src/plugins/game-config/GameConfigPane.spec.tsx`
- Modify: `studio/frontend/src/plugins/index.ts` (register plugin)
- Modify: `studio/frontend/src/app/routes/RoomRoute.tsx` + `RoomRoute.spec.tsx` (open/close on room enter/leave)

**Interfaces:**

- Consumes: everything from Tasks 1–7.
- Produces: `gameConfig: IPlugin<IGameConfigState>` (id `game-config`, pane `game-config/editor`, command `game-config/open-editor`); pane testids used by e2e: `gc-no-game`, `gc-stat-window`, `gc-stat-symbols`, `gc-stat-lines`, `gc-stat-strips`, `gc-sync-pill`, `gc-issues-pill`, `gc-tab-<tab>`, `gc-tab-dot-<tab>`. Sections are stubs (`<div data-testid="gc-section-<tab>" />`) replaced by Tasks 9–13.

- [ ] **Step 1: Write the six stub sections** (each file identical in shape)

```tsx
// studio/frontend/src/plugins/game-config/sections/SymbolsSection.tsx
export function SymbolsSection() {
  return <div data-testid="gc-section-symbols" className="p-3 text-xs text-text-3" />;
}
```

Repeat for `ReelsSection` (`gc-section-reels`), `PaylinesSection` (`gc-section-paylines`), `PaytableSection` (`gc-section-paytable`), `BonusSection` (`gc-section-bonus`), `JsonSection` (`gc-section-json`) — same one-liner with the matching testid and export name.

- [ ] **Step 2: Write the failing pane test**

```tsx
// studio/frontend/src/plugins/game-config/GameConfigPane.spec.tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { GAME_CONFIG_PLUGIN_ID, gameConfigSlice, makeInitialState } from './state';
import { GameConfigPane } from './GameConfigPane';
import type { ISlotModel } from './model';

const MODEL: ISlotModel = {
  symbols: [
    { id: 0, role: 'normal' },
    { id: 9, role: 'scatter' },
  ],
  reels: [
    [0, 9, 0],
    [0, 0, 9],
  ],
  rows: 3,
  paylines: [[0, 0]],
  paytable: { entries: [{ symbol: 0, count: 2, payout: 5 }] },
  bonuses: [],
};

function seed(model: ISlotModel | null) {
  rootStore.plugins.nested(GAME_CONFIG_PLUGIN_ID).set(makeInitialState() as never);
  act(() => {
    gameConfigSlice().activeGameId.set(model ? 'g1' : null);
    gameConfigSlice().model.set(model);
  });
}

describe('GameConfigPane', () => {
  beforeEach(() => seed(MODEL));

  it('shows an empty state with no active game', () => {
    seed(null);
    render(<GameConfigPane {...({} as never)} />);
    expect(screen.getByTestId('gc-no-game')).toBeTruthy();
  });

  it('renders header stats from the model', () => {
    render(<GameConfigPane {...({} as never)} />);
    expect(screen.getByTestId('gc-stat-window').textContent).toBe('3 × 2');
    expect(screen.getByTestId('gc-stat-symbols').textContent).toBe('2');
    expect(screen.getByTestId('gc-stat-lines').textContent).toBe('1');
    expect(screen.getByTestId('gc-stat-strips').textContent).toBe('3, 3');
  });

  it('shows the sync pill states', () => {
    render(<GameConfigPane {...({} as never)} />);
    expect(screen.getByTestId('gc-sync-pill').textContent).toContain('saved');
    act(() => {
      gameConfigSlice().sync.set('external');
      gameConfigSlice().externalSource.set('tuner');
    });
    expect(screen.getByTestId('gc-sync-pill').textContent).toContain('updated externally · tuner');
  });

  it('switches tabs and shows a warning dot for tabs with issues', () => {
    // paytable references symbol 0 twice → duplicate warning
    act(() => {
      gameConfigSlice().model.set({
        ...MODEL,
        paytable: {
          entries: [
            { symbol: 0, count: 2, payout: 5 },
            { symbol: 0, count: 2, payout: 3 },
          ],
        },
      });
    });
    render(<GameConfigPane {...({} as never)} />);
    expect(screen.getByTestId('gc-tab-dot-paytable')).toBeTruthy();
    expect(screen.getByTestId('gc-issues-pill').textContent).toContain('1 issue');
    fireEvent.click(screen.getByTestId('gc-tab-paytable'));
    expect(screen.getByTestId('gc-section-paytable')).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/plugins/game-config/GameConfigPane.spec.tsx`
Expected: FAIL — cannot resolve `./GameConfigPane`.

- [ ] **Step 4: Write the pane shell**

```tsx
// studio/frontend/src/plugins/game-config/GameConfigPane.tsx
import type { IDockviewPanelProps } from 'dockview-react';
import { gameConfigHooks } from './state';
import type { ISlotModel } from './model';
import { deriveStats } from './reducers';
import { validateModel, type GcTab } from './validate';
import { StatusPill, type StatusTone } from '../../components/ui/StatusPill';
import { SymbolsSection } from './sections/SymbolsSection';
import { ReelsSection } from './sections/ReelsSection';
import { PaylinesSection } from './sections/PaylinesSection';
import { PaytableSection } from './sections/PaytableSection';
import { BonusSection } from './sections/BonusSection';
import { JsonSection } from './sections/JsonSection';

const TABS: { key: GcTab; label: string }[] = [
  { key: 'symbols', label: 'Symbols' },
  { key: 'reels', label: 'Reels' },
  { key: 'paylines', label: 'Paylines' },
  { key: 'paytable', label: 'Paytable' },
  { key: 'bonus', label: 'Bonus' },
  { key: 'json', label: 'JSON' },
];

const SECTIONS: Record<GcTab, () => JSX.Element> = {
  symbols: SymbolsSection,
  reels: ReelsSection,
  paylines: PaylinesSection,
  paytable: PaytableSection,
  bonus: BonusSection,
  json: JsonSection,
};

function Stat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="rounded-lg border border-border bg-raised px-2.5 py-1">
      <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div data-testid={testId} className="text-sm text-text-1">
        {value}
      </div>
    </div>
  );
}

export function GameConfigPane(_props: IDockviewPanelProps) {
  const s = gameConfigHooks.usePluginState();
  const activeGameId = s.activeGameId.get();
  const model = s.model.get({ noproxy: true }) as ISlotModel | null;

  if (!activeGameId || !model) {
    return (
      <div data-testid="gc-no-game" className="flex h-full items-center justify-center bg-surface text-text-2">
        Open a game to edit its core configuration.
      </div>
    );
  }

  const stats = deriveStats(model);
  const issues = validateModel(model);
  const activeTab = s.activeTab.get();
  const sync = s.sync.get();
  const syncLabel =
    sync === 'saving' ? 'saving…' : sync === 'external' ? `updated externally · ${s.externalSource.get() ?? ''}` : sync === 'error' ? 'save failed' : 'saved';
  const syncTone: StatusTone = sync === 'external' ? 'warning' : sync === 'error' ? 'danger' : sync === 'saved' ? 'success' : 'neutral';
  const Section = SECTIONS[activeTab];

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex items-center gap-2 border-b border-hairline p-2">
        <Stat label="Window" value={`${stats.rows} × ${stats.reelCount}`} testId="gc-stat-window" />
        <Stat label="Symbols" value={String(stats.symbolCount)} testId="gc-stat-symbols" />
        <Stat label="Lines" value={String(stats.paylineCount)} testId="gc-stat-lines" />
        <Stat label="Strips" value={stats.stripLengths.join(', ')} testId="gc-stat-strips" />
        <span className="ml-auto inline-flex items-center gap-2">
          {issues.length > 0 && (
            <StatusPill data-testid="gc-issues-pill" tone="warning">
              {issues.length} issue{issues.length === 1 ? '' : 's'}
            </StatusPill>
          )}
          <StatusPill data-testid="gc-sync-pill" tone={syncTone}>
            {syncLabel}
          </StatusPill>
        </span>
      </div>

      <div className="flex items-center border-b border-hairline px-2">
        {TABS.map((t) => {
          const count = issues.filter((i) => i.tab === t.key).length;
          const active = t.key === activeTab;
          return (
            <button
              key={t.key}
              data-testid={`gc-tab-${t.key}`}
              onClick={() => s.activeTab.set(t.key)}
              className={`relative flex items-center gap-1.5 px-3 py-1.5 text-xs ${
                active ? 'border-b-2 border-primary text-text-1' : 'text-text-2 hover:text-text-1'
              }`}
            >
              {t.label}
              {count > 0 && <span data-testid={`gc-tab-dot-${t.key}`} className="h-1.5 w-1.5 rounded-full bg-warning" />}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <Section />
      </div>
    </div>
  );
}
```

Note: if `JSX.Element` is not in scope under the project's tsconfig, type `SECTIONS` as `Record<GcTab, () => ReactElement>` with `import type { ReactElement } from 'react'`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/plugins/game-config/GameConfigPane.spec.tsx`
Expected: PASS.

- [ ] **Step 6: Register the plugin**

```ts
// studio/frontend/src/plugins/game-config/index.ts
import type { IPlugin } from '../../host/types';
import { GameConfigPane } from './GameConfigPane';
import { GAME_CONFIG_PLUGIN_ID, makeInitialState, type IGameConfigState } from './state';
import { initGameConfig } from './actions';

export const gameConfig: IPlugin<IGameConfigState> = {
  id: GAME_CONFIG_PLUGIN_ID,
  title: 'Game Config',
  persist: false,
  initialState: makeInitialState(),
  panes: [{ id: 'game-config/editor', title: 'Game Config', component: GameConfigPane as never }],
  commands: [{ id: 'game-config/open-editor', title: 'Open Game Config', run: (host) => host.openPane('game-config/editor') }],
  init: () => initGameConfig(),
};
```

In `studio/frontend/src/plugins/index.ts` add the import and array entry (after `tuner`):

```ts
import { gameConfig } from './game-config';
```

```ts
  tuner,
  gameConfig,
```

- [ ] **Step 7: Wire room enter/leave in `RoomRoute.tsx`**

Add the import (after the tuner line):

```ts
import { openGameConfig, closeGameConfig } from '../../plugins/game-config/actions';
```

In the room-found block (after `if (found.gameId) void openGameTuner(found.gameId);`):

```ts
if (found.gameId) void openGameConfig(found.gameId);
```

In the unmount cleanup effect (after `closeGameTuner();`):

```ts
closeGameConfig();
```

- [ ] **Step 8: Update `RoomRoute.spec.tsx`**

Mirror the existing mock pattern: add near the other `vi.fn()` declarations

```ts
const openGameConfig = vi.fn();
const closeGameConfig = vi.fn();
```

add the module mock next to the tuner one:

```ts
vi.mock('../../plugins/game-config/actions', () => ({
  openGameConfig: (id: string) => openGameConfig(id),
  closeGameConfig: () => closeGameConfig(),
  initGameConfig: vi.fn(),
}));
```

add resets in the `beforeEach` alongside the others:

```ts
openGameConfig.mockReset();
closeGameConfig.mockReset();
```

- [ ] **Step 9: Run the full frontend suite**

Run: `npx vitest run src/plugins/game-config src/app/routes/RoomRoute.spec.tsx`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add studio/frontend/src/plugins/game-config studio/frontend/src/plugins/index.ts studio/frontend/src/app/routes/RoomRoute.tsx studio/frontend/src/app/routes/RoomRoute.spec.tsx
git commit -m "feat(game-config): cockpit pane shell, plugin registration, room wiring"
```

---

### Task 9: Symbols section

**Files:**

- Modify: `studio/frontend/src/plugins/game-config/sections/SymbolsSection.tsx` (replace stub)
- Test: `studio/frontend/src/plugins/game-config/sections/SymbolsSection.spec.tsx`

**Interfaces:**

- Consumes: `gameConfigHooks` (`../state`), `applyModel`/`applyPresentation` (`../actions`), `addSymbol`/`removeSymbol`/`setSymbolRole` (`../reducers`), `SWATCHES`/`SWATCH_DOT_CLASS`/`symbolLabel`/`symbolColor` (`../presentation`), `CommittedInput` (`../components/CommittedInput`), `validateModel` for inline issues.
- Produces testids: `gc-symbol-row-{id}`, `gc-symbol-label-{id}`, `gc-symbol-role-{id}` (a `<select>`), `gc-symbol-swatch-{id}-{swatch}`, `gc-symbol-delete-{id}`, `gc-add-symbol`.

- [ ] **Step 1: Write the failing test**

```tsx
// studio/frontend/src/plugins/game-config/sections/SymbolsSection.spec.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { rootStore } from '../../../state/rootStore';
import { GAME_CONFIG_PLUGIN_ID, gameConfigSlice, makeInitialState } from '../state';
import { SymbolsSection } from './SymbolsSection';

const applyModel = vi.fn();
const applyPresentation = vi.fn();
vi.mock('../actions', () => ({
  applyModel: (fn: unknown) => applyModel(fn),
  applyPresentation: (fn: unknown) => applyPresentation(fn),
}));

const MODEL = {
  symbols: [
    { id: 0, role: 'normal' as const },
    { id: 9, role: 'scatter' as const },
  ],
  reels: [[0, 9]],
  rows: 1,
  paylines: [[0]],
  paytable: { entries: [] },
  bonuses: [],
};

describe('SymbolsSection', () => {
  beforeEach(() => {
    applyModel.mockReset();
    applyPresentation.mockReset();
    rootStore.plugins.nested(GAME_CONFIG_PLUGIN_ID).set(makeInitialState() as never);
    act(() => {
      gameConfigSlice().activeGameId.set('g1');
      gameConfigSlice().model.set(MODEL);
      gameConfigSlice().presentation.set({ symbols: { '0': { label: 'Ace', color: 'sym-1' } } });
    });
  });

  it('renders one row per symbol with label fallback', () => {
    render(<SymbolsSection />);
    expect((screen.getByTestId('gc-symbol-label-0') as HTMLInputElement).value).toBe('Ace');
    expect((screen.getByTestId('gc-symbol-label-9') as HTMLInputElement).value).toBe('S9');
    expect((screen.getByTestId('gc-symbol-role-9') as HTMLSelectElement).value).toBe('scatter');
  });

  it('label commit goes through applyPresentation', () => {
    render(<SymbolsSection />);
    const el = screen.getByTestId('gc-symbol-label-0') as HTMLInputElement;
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: 'King' } });
    fireEvent.blur(el);
    expect(applyPresentation).toHaveBeenCalledTimes(1);
  });

  it('role change, swatch pick, delete, and add dispatch the right updates', () => {
    render(<SymbolsSection />);
    fireEvent.change(screen.getByTestId('gc-symbol-role-0'), { target: { value: 'wild' } });
    expect(applyModel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('gc-symbol-swatch-0-sym-4'));
    expect(applyPresentation).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('gc-symbol-delete-9'));
    expect(applyModel).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByTestId('gc-add-symbol'));
    expect(applyModel).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/plugins/game-config/sections/SymbolsSection.spec.tsx`
Expected: FAIL — stub has no inputs.

- [ ] **Step 3: Write the implementation**

```tsx
// studio/frontend/src/plugins/game-config/sections/SymbolsSection.tsx
import { gameConfigHooks } from '../state';
import type { ISlotModel, SymbolRole } from '../model';
import { applyModel, applyPresentation } from '../actions';
import { addSymbol, removeSymbol, setSymbolRole } from '../reducers';
import { SWATCHES, SWATCH_DOT_CLASS, symbolColor, symbolLabel, type IPresentation } from '../presentation';
import { CommittedInput } from '../components/CommittedInput';

const ROLES: SymbolRole[] = ['normal', 'wild', 'scatter'];

export function SymbolsSection() {
  const s = gameConfigHooks.usePluginState();
  const model = s.model.get({ noproxy: true }) as ISlotModel;
  const presentation = s.presentation.get({ noproxy: true }) as IPresentation;

  return (
    <div data-testid="gc-section-symbols" className="flex flex-col gap-1 p-3">
      {model.symbols.map((sym) => (
        <div key={sym.id} data-testid={`gc-symbol-row-${sym.id}`} className="flex items-center gap-2 rounded-lg border border-border bg-raised px-2.5 py-1.5">
          <span className="flex items-center gap-1">
            {SWATCHES.map((sw) => (
              <button
                key={sw}
                data-testid={`gc-symbol-swatch-${sym.id}-${sw}`}
                title={sw}
                onClick={() =>
                  applyPresentation((p) => ({
                    symbols: { ...p.symbols, [String(sym.id)]: { label: symbolLabel(p, sym.id), color: sw } },
                  }))
                }
                className={`h-3 w-3 rounded-full ${SWATCH_DOT_CLASS[sw]} ${
                  symbolColor(presentation, sym.id) === sw ? 'ring-2 ring-ring' : 'opacity-40 hover:opacity-100'
                }`}
              />
            ))}
          </span>
          <CommittedInput
            testId={`gc-symbol-label-${sym.id}`}
            value={symbolLabel(presentation, sym.id)}
            kind="text"
            onCommit={(label) =>
              applyPresentation((p) => ({
                symbols: { ...p.symbols, [String(sym.id)]: { label, color: symbolColor(p, sym.id) } },
              }))
            }
          />
          <select
            data-testid={`gc-symbol-role-${sym.id}`}
            value={sym.role}
            onChange={(e) => applyModel((m) => setSymbolRole(m, sym.id, e.target.value as SymbolRole))}
            className="h-6 rounded border border-border bg-canvas px-1 text-xs text-text-1"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <span className="ml-auto font-mono text-[10px] text-text-3">id {sym.id}</span>
          <button
            data-testid={`gc-symbol-delete-${sym.id}`}
            onClick={() => applyModel((m) => removeSymbol(m, sym.id))}
            className="rounded px-1.5 py-0.5 text-xs text-text-2 hover:bg-raised-hover hover:text-danger"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        data-testid="gc-add-symbol"
        onClick={() => applyModel((m) => addSymbol(m))}
        className="mt-1 self-start rounded border border-border px-3 py-1 text-xs text-text-1 hover:bg-raised-hover"
      >
        + Add symbol
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/plugins/game-config/sections/SymbolsSection.spec.tsx src/plugins/game-config/GameConfigPane.spec.tsx`
Expected: PASS (pane spec still green — the stub swap is invisible to it).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/game-config/sections
git commit -m "feat(game-config): symbols section (labels, roles, swatches)"
```

---

### Task 10: Reels section (strip + composition lenses, window, reel sets)

**Files:**

- Modify: `studio/frontend/src/plugins/game-config/sections/ReelsSection.tsx` (replace stub)
- Test: `studio/frontend/src/plugins/game-config/sections/ReelsSection.spec.tsx`

**Interfaces:**

- Consumes: `gameConfigHooks`, `applyModel` (mocked in tests), reducers (`getStrips`, `countOccurrences`, `insertStripCell`, `replaceStripCell`, `removeStripCell`, `moveStripCell`, `appendStripCell`, `setSymbolCount`, `setRows`, `setReelCount`, `addFeatureReels`, `clearFeatureReels`), `SymbolChip`, `Stepper`, presentation helpers.
- Produces testids: `gc-rows-stepper`(+`-inc`/`-dec`), `gc-reels-stepper`(+`-inc`/`-dec`), `gc-reelset-select`, `gc-add-feature-reels`, `gc-clear-feature-reels`, `gc-lens-strip`, `gc-lens-composition`, `gc-strip-col-{r}`, `gc-strip-cell-{r}-{i}`, `gc-strip-add-{r}`, `gc-cell-menu` (popover), `gc-cell-replace-{symbolId}`, `gc-cell-insert-after`, `gc-cell-remove`, `gc-comp-count-{symbolId}-{r}`(+`-inc`/`-dec`), `gc-strip-len-{r}`, `gc-freq-{symbolId}-{r}`.

UI behavior:

- Top strip: `Stepper` for rows (min 1, max 8) and reel count (min 1, max 8); reel-set `<select>` (`base` + one option per bonus, value `bonus-{i}`); when a bonus set is selected and its `feature_reels` is null, show `gc-add-feature-reels` ("Add feature strips") instead of the grids; when non-null, show `gc-clear-feature-reels` ("Revert to base").
- Lens toggle: two buttons, active one `border-primary text-text-1`, inactive `text-text-2`.
- Strip view: one column per reel; each cell renders a `SymbolChip` in a button; clicking opens a popover (component-local `useState<{ reel: number; index: number } | null>`) with: all symbols as replace buttons (`gc-cell-replace-{id}`), "insert after" (`gc-cell-insert-after`, inserts a copy of the current cell's symbol after it), "remove" (`gc-cell-remove`). Cells are `draggable`; `onDragStart` stores the index, `onDrop` on another cell calls `moveStripCell`. `gc-strip-add-{r}` appends the first symbol (`model.symbols[0]`) via `appendStripCell`.
- Composition view: table with one row per symbol (chip in the row header), one column per reel; each cell is a `Stepper` bound to `countOccurrences(strip, symbol)` calling `setSymbolCount`. Footer rows: strip length per reel (`gc-strip-len-{r}`) and per-symbol frequency % (`gc-freq-{sym}-{r}`, `Math.round(100 * count / len)` with `—` for empty strips).

- [ ] **Step 1: Write the failing test**

```tsx
// studio/frontend/src/plugins/game-config/sections/ReelsSection.spec.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { rootStore } from '../../../state/rootStore';
import { GAME_CONFIG_PLUGIN_ID, gameConfigSlice, makeInitialState } from '../state';
import type { ISlotModel } from '../model';
import { ReelsSection } from './ReelsSection';

const applyModel = vi.fn();
vi.mock('../actions', () => ({
  applyModel: (fn: (m: ISlotModel) => ISlotModel) => applyModel(fn),
  applyPresentation: vi.fn(),
}));

const MODEL: ISlotModel = {
  symbols: [
    { id: 0, role: 'normal' },
    { id: 9, role: 'scatter' },
  ],
  reels: [
    [0, 9, 0],
    [0, 0, 9],
  ],
  rows: 3,
  paylines: [[0, 0]],
  paytable: { entries: [] },
  bonuses: [
    {
      FreeSpins: {
        trigger: { symbol: 9, min_count: 3 },
        config: { spins_awarded: 5, retrigger: false, multiplier: 1, feature_reels: null },
      },
    },
  ],
};

// Run the last dispatched transform against the current model — asserts end-state,
// not just that something was dispatched.
function lastTransformResult(): ISlotModel {
  const fn = applyModel.mock.calls.at(-1)![0] as (m: ISlotModel) => ISlotModel;
  return fn(gameConfigSlice().model.get({ noproxy: true }) as ISlotModel);
}

describe('ReelsSection', () => {
  beforeEach(() => {
    applyModel.mockReset();
    rootStore.plugins.nested(GAME_CONFIG_PLUGIN_ID).set(makeInitialState() as never);
    act(() => {
      gameConfigSlice().activeGameId.set('g1');
      gameConfigSlice().model.set(MODEL);
    });
  });

  it('renders strip columns with one chip per cell', () => {
    render(<ReelsSection />);
    expect(screen.getByTestId('gc-strip-cell-0-1')).toBeTruthy();
    expect(screen.getByTestId('gc-strip-cell-1-2')).toBeTruthy();
  });

  it('window steppers dispatch setRows / setReelCount transforms', () => {
    render(<ReelsSection />);
    fireEvent.click(screen.getByTestId('gc-rows-stepper-inc'));
    expect(lastTransformResult().rows).toBe(4);
    fireEvent.click(screen.getByTestId('gc-reels-stepper-inc'));
    expect(lastTransformResult().reels).toHaveLength(3);
  });

  it('cell popover replace/insert/remove transform the strip', () => {
    render(<ReelsSection />);
    fireEvent.click(screen.getByTestId('gc-strip-cell-0-0'));
    fireEvent.click(screen.getByTestId('gc-cell-replace-9'));
    expect(lastTransformResult().reels[0]).toEqual([9, 9, 0]);
    fireEvent.click(screen.getByTestId('gc-strip-cell-0-0'));
    fireEvent.click(screen.getByTestId('gc-cell-insert-after'));
    expect(lastTransformResult().reels[0]).toEqual([0, 0, 9, 0]);
    fireEvent.click(screen.getByTestId('gc-strip-cell-0-1'));
    fireEvent.click(screen.getByTestId('gc-cell-remove'));
    expect(lastTransformResult().reels[0]).toEqual([0, 0]);
  });

  it('composition lens steppers call setSymbolCount with append/remove-last semantics', () => {
    render(<ReelsSection />);
    fireEvent.click(screen.getByTestId('gc-lens-composition'));
    expect(screen.getByTestId('gc-comp-count-0-0').textContent).toBe('2');
    fireEvent.click(screen.getByTestId('gc-comp-count-0-0-inc'));
    expect(lastTransformResult().reels[0]).toEqual([0, 9, 0, 0]);
    expect(screen.getByTestId('gc-strip-len-0').textContent).toBe('3');
    expect(screen.getByTestId('gc-freq-0-0').textContent).toBe('67%');
  });

  it('feature reel set offers add / revert', () => {
    render(<ReelsSection />);
    fireEvent.change(screen.getByTestId('gc-reelset-select'), { target: { value: 'bonus-0' } });
    fireEvent.click(screen.getByTestId('gc-add-feature-reels'));
    const out = lastTransformResult();
    expect(out.bonuses[0].FreeSpins.config.feature_reels).toEqual(MODEL.reels);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/plugins/game-config/sections/ReelsSection.spec.tsx`
Expected: FAIL — stub has no controls.

- [ ] **Step 3: Write the implementation**

```tsx
// studio/frontend/src/plugins/game-config/sections/ReelsSection.tsx
import { useState } from 'react';
import { gameConfigHooks } from '../state';
import type { ISlotModel } from '../model';
import type { IPresentation } from '../presentation';
import { applyModel } from '../actions';
import {
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
  type ReelSetRef,
} from '../reducers';
import { SymbolChip } from '../components/SymbolChip';
import { Stepper } from '../components/Stepper';

export function ReelsSection() {
  const s = gameConfigHooks.usePluginState();
  const model = s.model.get({ noproxy: true }) as ISlotModel;
  const presentation = s.presentation.get({ noproxy: true }) as IPresentation;
  const lens = s.reelLens.get();
  const ref = s.activeReelSet.get() as ReelSetRef;
  const [openCell, setOpenCell] = useState<{ reel: number; index: number } | null>(null);
  const [dragFrom, setDragFrom] = useState<{ reel: number; index: number } | null>(null);

  const strips = getStrips(model, ref);
  const lensBtn = (active: boolean) => `px-3 py-1 text-xs ${active ? 'border-b-2 border-primary text-text-1' : 'text-text-2 hover:text-text-1'}`;

  return (
    <div data-testid="gc-section-reels" className="flex flex-col gap-2 p-3">
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-2 text-xs text-text-2">
          Rows <Stepper value={model.rows} min={1} max={8} onChange={(v) => applyModel((m) => setRows(m, v))} testId="gc-rows-stepper" />
        </span>
        <span className="flex items-center gap-2 text-xs text-text-2">
          Reels <Stepper value={model.reels.length} min={1} max={8} onChange={(v) => applyModel((m) => setReelCount(m, v))} testId="gc-reels-stepper" />
        </span>
        <select
          data-testid="gc-reelset-select"
          value={ref === 'base' ? 'base' : `bonus-${ref}`}
          onChange={(e) => s.activeReelSet.set(e.target.value === 'base' ? 'base' : Number(e.target.value.slice(6)))}
          className="h-6 rounded border border-border bg-canvas px-1 text-xs text-text-1"
        >
          <option value="base">Base reels</option>
          {model.bonuses.map((_, i) => (
            <option key={i} value={`bonus-${i}`}>
              FreeSpins {i + 1} feature reels
            </option>
          ))}
        </select>
        <span className="ml-auto">
          <button data-testid="gc-lens-strip" className={lensBtn(lens === 'strip')} onClick={() => s.reelLens.set('strip')}>
            Strip
          </button>
          <button data-testid="gc-lens-composition" className={lensBtn(lens === 'composition')} onClick={() => s.reelLens.set('composition')}>
            Composition
          </button>
        </span>
      </div>

      {ref !== 'base' && strips === null && (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-border bg-raised p-3 text-xs text-text-2">
          This bonus uses the base reels during free spins.
          <button
            data-testid="gc-add-feature-reels"
            onClick={() => applyModel((m) => addFeatureReels(m, ref))}
            className="rounded border border-border px-3 py-1 text-text-1 hover:bg-raised-hover"
          >
            Add feature strips (clone base)
          </button>
        </div>
      )}

      {strips !== null && (
        <>
          {ref !== 'base' && (
            <button
              data-testid="gc-clear-feature-reels"
              onClick={() => applyModel((m) => clearFeatureReels(m, ref))}
              className="self-start rounded border border-border px-3 py-1 text-xs text-text-2 hover:bg-raised-hover"
            >
              Revert to base (remove feature strips)
            </button>
          )}

          {lens === 'strip' ? (
            <div className="flex items-start gap-3 overflow-x-auto">
              {strips.map((strip, r) => (
                <div key={r} data-testid={`gc-strip-col-${r}`} className="flex min-w-24 flex-col gap-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                    R{r + 1} · {strip.length}
                  </span>
                  {strip.map((sym, i) => (
                    <span key={i} className="relative">
                      <button
                        data-testid={`gc-strip-cell-${r}-${i}`}
                        draggable
                        onDragStart={() => setDragFrom({ reel: r, index: i })}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => {
                          if (dragFrom && dragFrom.reel === r) applyModel((m) => moveStripCell(m, ref, r, dragFrom.index, i));
                          setDragFrom(null);
                        }}
                        onClick={() => setOpenCell(openCell?.reel === r && openCell.index === i ? null : { reel: r, index: i })}
                        className="w-full rounded hover:bg-raised-hover"
                      >
                        <SymbolChip presentation={presentation} id={sym} />
                      </button>
                      {openCell?.reel === r && openCell.index === i && (
                        <div
                          data-testid="gc-cell-menu"
                          className="absolute left-full top-0 z-10 ml-1 flex w-40 flex-col gap-1 rounded-lg border border-border-strong bg-popover p-2"
                        >
                          <span className="text-[10px] uppercase text-muted-foreground">Replace with</span>
                          <span className="flex flex-wrap gap-1">
                            {model.symbols.map((sd) => (
                              <button
                                key={sd.id}
                                data-testid={`gc-cell-replace-${sd.id}`}
                                onClick={() => {
                                  applyModel((m) => replaceStripCell(m, ref, r, i, sd.id));
                                  setOpenCell(null);
                                }}
                              >
                                <SymbolChip presentation={presentation} id={sd.id} />
                              </button>
                            ))}
                          </span>
                          <button
                            data-testid="gc-cell-insert-after"
                            onClick={() => {
                              applyModel((m) => insertStripCell(m, ref, r, i + 1, sym));
                              setOpenCell(null);
                            }}
                            className="rounded px-1.5 py-0.5 text-left text-xs text-text-1 hover:bg-raised-hover"
                          >
                            Insert copy after
                          </button>
                          <button
                            data-testid="gc-cell-remove"
                            onClick={() => {
                              applyModel((m) => removeStripCell(m, ref, r, i));
                              setOpenCell(null);
                            }}
                            className="rounded px-1.5 py-0.5 text-left text-xs text-danger hover:bg-raised-hover"
                          >
                            Remove
                          </button>
                        </div>
                      )}
                    </span>
                  ))}
                  <button
                    data-testid={`gc-strip-add-${r}`}
                    onClick={() => model.symbols[0] && applyModel((m) => appendStripCell(m, ref, r, model.symbols[0].id))}
                    className="rounded border border-border px-2 py-0.5 text-xs text-text-2 hover:bg-raised-hover"
                  >
                    +
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <table className="w-fit text-xs text-text-1">
              <thead>
                <tr>
                  <th className="pr-3 text-left text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Symbol</th>
                  {strips.map((_, r) => (
                    <th key={r} className="px-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                      R{r + 1}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {model.symbols.map((sd) => (
                  <tr key={sd.id}>
                    <td className="py-0.5 pr-3">
                      <SymbolChip presentation={presentation} id={sd.id} />
                    </td>
                    {strips.map((strip, r) => (
                      <td key={r} className="px-2 py-0.5">
                        <Stepper
                          value={countOccurrences(strip, sd.id)}
                          onChange={(v) => applyModel((m) => setSymbolCount(m, ref, r, sd.id, v))}
                          testId={`gc-comp-count-${sd.id}-${r}`}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className="border-t border-hairline text-text-2">
                  <td className="py-0.5 pr-3">strip length</td>
                  {strips.map((strip, r) => (
                    <td key={r} data-testid={`gc-strip-len-${r}`} className="px-2 text-center font-mono">
                      {strip.length}
                    </td>
                  ))}
                </tr>
                {model.symbols.map((sd) => (
                  <tr key={`freq-${sd.id}`} className="text-text-3">
                    <td className="py-0.5 pr-3">
                      {`freq `}
                      <SymbolChip presentation={presentation} id={sd.id} />
                    </td>
                    {strips.map((strip, r) => (
                      <td key={r} data-testid={`gc-freq-${sd.id}-${r}`} className="px-2 text-center font-mono">
                        {strip.length === 0 ? '—' : `${Math.round((100 * countOccurrences(strip, sd.id)) / strip.length)}%`}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/plugins/game-config/sections/ReelsSection.spec.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/game-config/sections/ReelsSection.tsx studio/frontend/src/plugins/game-config/sections/ReelsSection.spec.tsx
git commit -m "feat(game-config): reels section with strip + composition lenses"
```

---

### Task 11: Paylines section (grid painter + overview)

**Files:**

- Modify: `studio/frontend/src/plugins/game-config/sections/PaylinesSection.tsx` (replace stub)
- Test: `studio/frontend/src/plugins/game-config/sections/PaylinesSection.spec.tsx`

**Interfaces:**

- Consumes: `gameConfigHooks`, `applyModel` (mocked in tests), `addPayline`/`duplicatePayline`/`removePayline`/`setPaylineCell` (`../reducers`), `validateModel` for inline issues.
- Produces testids: `gc-payline-card-{i}`, `gc-pl-cell-{i}-{reel}-{row}`, `gc-add-payline`, `gc-dup-payline-{i}`, `gc-del-payline-{i}`, `gc-payline-issue-{i}`, `gc-lines-overview`, `gc-ov-cell-{reel}-{row}`.

UI behavior: each payline renders a card with a rows × reels grid of small square buttons; the selected cell per column (where `line[reel] === row`) is painted `bg-selection` with `border-primary`; clicking any cell calls `setPaylineCell`. Validation issues whose `path` is `paylines[{i}]` render inline under the card (`gc-payline-issue-{i}`, `text-danger`). The overview card (`gc-lines-overview`) renders the same grid once; a cell crossed by N lines shows N (blank for 0) — density check only, not clickable.

- [ ] **Step 1: Write the failing test**

```tsx
// studio/frontend/src/plugins/game-config/sections/PaylinesSection.spec.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { rootStore } from '../../../state/rootStore';
import { GAME_CONFIG_PLUGIN_ID, gameConfigSlice, makeInitialState } from '../state';
import type { ISlotModel } from '../model';
import { PaylinesSection } from './PaylinesSection';

const applyModel = vi.fn();
vi.mock('../actions', () => ({
  applyModel: (fn: (m: ISlotModel) => ISlotModel) => applyModel(fn),
  applyPresentation: vi.fn(),
}));

const MODEL: ISlotModel = {
  symbols: [{ id: 0, role: 'normal' }],
  reels: [
    [0, 0],
    [0, 0],
    [0, 0],
  ],
  rows: 3,
  paylines: [
    [0, 0, 0],
    [1, 1, 1],
  ],
  paytable: { entries: [] },
  bonuses: [],
};

function lastTransformResult(): ISlotModel {
  const fn = applyModel.mock.calls.at(-1)![0] as (m: ISlotModel) => ISlotModel;
  return fn(gameConfigSlice().model.get({ noproxy: true }) as ISlotModel);
}

describe('PaylinesSection', () => {
  beforeEach(() => {
    applyModel.mockReset();
    rootStore.plugins.nested(GAME_CONFIG_PLUGIN_ID).set(makeInitialState() as never);
    act(() => {
      gameConfigSlice().activeGameId.set('g1');
      gameConfigSlice().model.set(MODEL);
    });
  });

  it('renders a card per line with the selected cells painted', () => {
    render(<PaylinesSection />);
    expect(screen.getByTestId('gc-payline-card-0')).toBeTruthy();
    // line 1 selects row 1 on every reel
    expect(screen.getByTestId('gc-pl-cell-1-0-1').className).toContain('bg-selection');
    expect(screen.getByTestId('gc-pl-cell-1-0-0').className).not.toContain('bg-selection');
  });

  it('clicking a cell repaints that reel of that line', () => {
    render(<PaylinesSection />);
    fireEvent.click(screen.getByTestId('gc-pl-cell-0-1-2'));
    expect(lastTransformResult().paylines[0]).toEqual([0, 2, 0]);
  });

  it('add / duplicate / delete dispatch the right transforms', () => {
    render(<PaylinesSection />);
    fireEvent.click(screen.getByTestId('gc-add-payline'));
    expect(lastTransformResult().paylines).toHaveLength(3);
    fireEvent.click(screen.getByTestId('gc-dup-payline-1'));
    expect(lastTransformResult().paylines[2]).toEqual([1, 1, 1]);
    fireEvent.click(screen.getByTestId('gc-del-payline-0'));
    expect(lastTransformResult().paylines).toEqual([[1, 1, 1]]);
  });

  it('shows an inline issue for an invalid line and counts overlaps in the overview', () => {
    act(() => {
      gameConfigSlice().model.set({
        ...MODEL,
        paylines: [
          [0, 0],
          [1, 1, 1],
        ],
      }); // line 0 too short
    });
    render(<PaylinesSection />);
    expect(screen.getByTestId('gc-payline-issue-0').textContent).toContain('reel count');
    expect(screen.getByTestId('gc-ov-cell-0-1').textContent).toBe('1'); // only line 1 crosses
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/plugins/game-config/sections/PaylinesSection.spec.tsx`
Expected: FAIL — stub has no cards.

- [ ] **Step 3: Write the implementation**

```tsx
// studio/frontend/src/plugins/game-config/sections/PaylinesSection.tsx
import { gameConfigHooks } from '../state';
import type { ISlotModel } from '../model';
import { applyModel } from '../actions';
import { addPayline, duplicatePayline, removePayline, setPaylineCell } from '../reducers';
import { validateModel } from '../validate';

function CellGrid({
  rows,
  reels,
  isOn,
  onClick,
  cellTestId,
}: {
  rows: number;
  reels: number;
  isOn: (reel: number, row: number) => boolean;
  onClick?: (reel: number, row: number) => void;
  cellTestId: (reel: number, row: number) => string;
}) {
  return (
    <div className="flex gap-1">
      {Array.from({ length: reels }, (_, reel) => (
        <div key={reel} className="flex flex-col gap-1">
          {Array.from({ length: rows }, (_, row) => (
            <button
              key={row}
              data-testid={cellTestId(reel, row)}
              onClick={onClick ? () => onClick(reel, row) : undefined}
              disabled={!onClick}
              className={`h-6 w-6 rounded border text-[10px] ${
                isOn(reel, row) ? 'border-primary bg-selection text-selection-text' : 'border-border bg-canvas text-text-3'
              } ${onClick ? 'hover:border-border-strong' : ''}`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function PaylinesSection() {
  const s = gameConfigHooks.usePluginState();
  const model = s.model.get({ noproxy: true }) as ISlotModel;
  const issues = validateModel(model).filter((i) => i.tab === 'paylines');
  const reels = model.reels.length;

  return (
    <div data-testid="gc-section-paylines" className="flex flex-wrap items-start gap-3 p-3">
      {model.paylines.map((line, i) => {
        const lineIssues = issues.filter((iss) => iss.path === `paylines[${i}]`);
        return (
          <div key={i} data-testid={`gc-payline-card-${i}`} className="flex flex-col gap-2 rounded-lg border border-border bg-raised p-2.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Line {i + 1}</span>
              <button
                data-testid={`gc-dup-payline-${i}`}
                onClick={() => applyModel((m) => duplicatePayline(m, i))}
                className="ml-auto rounded px-1.5 py-0.5 text-xs text-text-2 hover:bg-raised-hover"
              >
                ⧉
              </button>
              <button
                data-testid={`gc-del-payline-${i}`}
                onClick={() => applyModel((m) => removePayline(m, i))}
                className="rounded px-1.5 py-0.5 text-xs text-text-2 hover:bg-raised-hover hover:text-danger"
              >
                ✕
              </button>
            </div>
            <CellGrid
              rows={model.rows}
              reels={reels}
              isOn={(reel, row) => line[reel] === row}
              onClick={(reel, row) => applyModel((m) => setPaylineCell(m, i, reel, row))}
              cellTestId={(reel, row) => `gc-pl-cell-${i}-${reel}-${row}`}
            />
            {lineIssues.map((iss, k) => (
              <span key={k} data-testid={`gc-payline-issue-${i}`} className="text-[11px] text-danger">
                {iss.message}
              </span>
            ))}
          </div>
        );
      })}

      <button
        data-testid="gc-add-payline"
        onClick={() => applyModel((m) => addPayline(m))}
        className="rounded border border-border px-3 py-1 text-xs text-text-1 hover:bg-raised-hover"
      >
        + Add line
      </button>

      <div data-testid="gc-lines-overview" className="flex flex-col gap-2 rounded-lg border border-border bg-raised p-2.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">All lines</span>
        <div className="flex gap-1">
          {Array.from({ length: reels }, (_, reel) => (
            <div key={reel} className="flex flex-col gap-1">
              {Array.from({ length: model.rows }, (_, row) => {
                const n = model.paylines.filter((l) => l[reel] === row).length;
                return (
                  <span
                    key={row}
                    data-testid={`gc-ov-cell-${reel}-${row}`}
                    className={`flex h-6 w-6 items-center justify-center rounded border text-[10px] ${
                      n > 0 ? 'border-primary bg-selection text-selection-text' : 'border-border bg-canvas text-text-3'
                    }`}
                  >
                    {n > 0 ? n : ''}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/plugins/game-config/sections/PaylinesSection.spec.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/game-config/sections/PaylinesSection.tsx studio/frontend/src/plugins/game-config/sections/PaylinesSection.spec.tsx
git commit -m "feat(game-config): payline grid painter + all-lines overview"
```

---

### Task 12: Paytable + Bonus sections

**Files:**

- Modify: `studio/frontend/src/plugins/game-config/sections/PaytableSection.tsx` (replace stub)
- Modify: `studio/frontend/src/plugins/game-config/sections/BonusSection.tsx` (replace stub)
- Test: `studio/frontend/src/plugins/game-config/sections/PaytableSection.spec.tsx`
- Test: `studio/frontend/src/plugins/game-config/sections/BonusSection.spec.tsx`

**Interfaces:**

- Consumes: `gameConfigHooks`, `applyModel` (mocked in tests), paytable/bonus reducers, `SymbolChip`, `Stepper`, `CommittedInput`, `validateModel`.
- Produces testids — paytable: `gc-pt-group-{symbolId}`, `gc-pt-row-{i}` (index into `paytable.entries`), `gc-pt-count-{i}`(+`-inc`/`-dec`), `gc-pt-payout-{i}`, `gc-pt-delete-{i}`, `gc-add-pt-row-{symbolId}`, `gc-pt-issue-{i}`; bonus: `gc-bonus-card-{b}`, `gc-bonus-trigger-symbol-{b}` (select of scatter-role symbols, plus the current value if non-scatter), `gc-bonus-min-count-{b}`(+`-inc`/`-dec`), `gc-bonus-spins-{b}`(+`-inc`/`-dec`), `gc-bonus-multiplier-{b}`, `gc-bonus-retrigger-{b}` (checkbox), `gc-bonus-delete-{b}`, `gc-add-bonus`, `gc-bonus-issue-{b}`, `gc-bonus-feature-note-{b}`.

UI behavior — paytable: entries grouped by symbol in `model.symbols` order (each group headed by a `SymbolChip` + `gc-add-pt-row-{id}` button); each row: count `Stepper` (min 1), payout `CommittedInput` (int), delete. Scatter-role groups annotate "pays on total grid count", others "left-aligned run". Issues matching `paytable.entries[{i}]` render inline (`gc-pt-issue-{i}`, danger for errors, warning tone for warnings). Bonus: one card per bonus with the controls above; feature-reels note is read-only text ("Feature strips: base" or "custom — edited in Reels tab"); `gc-add-bonus` appends via `addBonus`.

- [ ] **Step 1: Write the failing paytable test**

```tsx
// studio/frontend/src/plugins/game-config/sections/PaytableSection.spec.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { rootStore } from '../../../state/rootStore';
import { GAME_CONFIG_PLUGIN_ID, gameConfigSlice, makeInitialState } from '../state';
import type { ISlotModel } from '../model';
import { PaytableSection } from './PaytableSection';

const applyModel = vi.fn();
vi.mock('../actions', () => ({
  applyModel: (fn: (m: ISlotModel) => ISlotModel) => applyModel(fn),
  applyPresentation: vi.fn(),
}));

const MODEL: ISlotModel = {
  symbols: [
    { id: 0, role: 'normal' },
    { id: 9, role: 'scatter' },
  ],
  reels: [
    [0, 9],
    [0, 9],
    [0, 9],
  ],
  rows: 3,
  paylines: [[0, 0, 0]],
  paytable: {
    entries: [
      { symbol: 0, count: 3, payout: 5 },
      { symbol: 9, count: 3, payout: 0 }, // zero payout → warning
    ],
  },
  bonuses: [],
};

function lastTransformResult(): ISlotModel {
  const fn = applyModel.mock.calls.at(-1)![0] as (m: ISlotModel) => ISlotModel;
  return fn(gameConfigSlice().model.get({ noproxy: true }) as ISlotModel);
}

describe('PaytableSection', () => {
  beforeEach(() => {
    applyModel.mockReset();
    rootStore.plugins.nested(GAME_CONFIG_PLUGIN_ID).set(makeInitialState() as never);
    act(() => {
      gameConfigSlice().activeGameId.set('g1');
      gameConfigSlice().model.set(MODEL);
    });
  });

  it('groups rows by symbol and annotates scatter semantics', () => {
    render(<PaytableSection />);
    expect(screen.getByTestId('gc-pt-group-0').textContent).toContain('left-aligned run');
    expect(screen.getByTestId('gc-pt-group-9').textContent).toContain('total grid count');
  });

  it('count stepper, payout input, delete and add dispatch transforms', () => {
    render(<PaytableSection />);
    fireEvent.click(screen.getByTestId('gc-pt-count-0-inc'));
    expect(lastTransformResult().paytable.entries[0].count).toBe(4);
    const payout = screen.getByTestId('gc-pt-payout-0') as HTMLInputElement;
    fireEvent.focus(payout);
    fireEvent.change(payout, { target: { value: '25' } });
    fireEvent.blur(payout);
    expect(lastTransformResult().paytable.entries[0].payout).toBe(25);
    fireEvent.click(screen.getByTestId('gc-pt-delete-1'));
    expect(lastTransformResult().paytable.entries).toHaveLength(1);
    fireEvent.click(screen.getByTestId('gc-add-pt-row-0'));
    expect(lastTransformResult().paytable.entries).toHaveLength(3);
  });

  it('renders the zero-payout warning inline', () => {
    render(<PaytableSection />);
    expect(screen.getByTestId('gc-pt-issue-1').textContent).toContain('zero payout');
  });
});
```

- [ ] **Step 2: Write the failing bonus test**

```tsx
// studio/frontend/src/plugins/game-config/sections/BonusSection.spec.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { rootStore } from '../../../state/rootStore';
import { GAME_CONFIG_PLUGIN_ID, gameConfigSlice, makeInitialState } from '../state';
import type { ISlotModel } from '../model';
import { BonusSection } from './BonusSection';

const applyModel = vi.fn();
vi.mock('../actions', () => ({
  applyModel: (fn: (m: ISlotModel) => ISlotModel) => applyModel(fn),
  applyPresentation: vi.fn(),
}));

const MODEL: ISlotModel = {
  symbols: [
    { id: 0, role: 'normal' },
    { id: 9, role: 'scatter' },
  ],
  reels: [
    [0, 9],
    [0, 9],
    [0, 9],
  ],
  rows: 3,
  paylines: [[0, 0, 0]],
  paytable: { entries: [] },
  bonuses: [
    {
      FreeSpins: {
        trigger: { symbol: 9, min_count: 3 },
        config: { spins_awarded: 5, retrigger: true, multiplier: 2, feature_reels: null },
      },
    },
  ],
};

function lastTransformResult(): ISlotModel {
  const fn = applyModel.mock.calls.at(-1)![0] as (m: ISlotModel) => ISlotModel;
  return fn(gameConfigSlice().model.get({ noproxy: true }) as ISlotModel);
}

describe('BonusSection', () => {
  beforeEach(() => {
    applyModel.mockReset();
    rootStore.plugins.nested(GAME_CONFIG_PLUGIN_ID).set(makeInitialState() as never);
    act(() => {
      gameConfigSlice().activeGameId.set('g1');
      gameConfigSlice().model.set(MODEL);
    });
  });

  it('renders the FreeSpins card with current values', () => {
    render(<BonusSection />);
    expect((screen.getByTestId('gc-bonus-trigger-symbol-0') as HTMLSelectElement).value).toBe('9');
    expect(screen.getByTestId('gc-bonus-spins-0').textContent).toBe('5');
    expect((screen.getByTestId('gc-bonus-retrigger-0') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('gc-bonus-feature-note-0').textContent).toContain('base');
  });

  it('edits dispatch trigger/config transforms', () => {
    render(<BonusSection />);
    fireEvent.click(screen.getByTestId('gc-bonus-min-count-0-inc'));
    expect(lastTransformResult().bonuses[0].FreeSpins.trigger.min_count).toBe(4);
    fireEvent.click(screen.getByTestId('gc-bonus-spins-0-inc'));
    expect(lastTransformResult().bonuses[0].FreeSpins.config.spins_awarded).toBe(6);
    fireEvent.click(screen.getByTestId('gc-bonus-retrigger-0'));
    expect(lastTransformResult().bonuses[0].FreeSpins.config.retrigger).toBe(false);
    const mult = screen.getByTestId('gc-bonus-multiplier-0') as HTMLInputElement;
    fireEvent.focus(mult);
    fireEvent.change(mult, { target: { value: '3' } });
    fireEvent.blur(mult);
    expect(lastTransformResult().bonuses[0].FreeSpins.config.multiplier).toBe(3);
  });

  it('add and delete bonuses', () => {
    render(<BonusSection />);
    fireEvent.click(screen.getByTestId('gc-add-bonus'));
    expect(lastTransformResult().bonuses).toHaveLength(2);
    fireEvent.click(screen.getByTestId('gc-bonus-delete-0'));
    expect(lastTransformResult().bonuses).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/plugins/game-config/sections/PaytableSection.spec.tsx src/plugins/game-config/sections/BonusSection.spec.tsx`
Expected: FAIL — stubs have no controls.

- [ ] **Step 4: Write PaytableSection**

```tsx
// studio/frontend/src/plugins/game-config/sections/PaytableSection.tsx
import { gameConfigHooks } from '../state';
import type { ISlotModel } from '../model';
import type { IPresentation } from '../presentation';
import { applyModel } from '../actions';
import { addPaytableRow, removePaytableRow, updatePaytableRow } from '../reducers';
import { validateModel } from '../validate';
import { SymbolChip } from '../components/SymbolChip';
import { Stepper } from '../components/Stepper';
import { CommittedInput } from '../components/CommittedInput';

export function PaytableSection() {
  const s = gameConfigHooks.usePluginState();
  const model = s.model.get({ noproxy: true }) as ISlotModel;
  const presentation = s.presentation.get({ noproxy: true }) as IPresentation;
  const issues = validateModel(model).filter((i) => i.tab === 'paytable');

  return (
    <div data-testid="gc-section-paytable" className="flex flex-col gap-3 p-3">
      {model.symbols.map((sd) => {
        const rows = model.paytable.entries.map((e, i) => ({ e, i })).filter(({ e }) => e.symbol === sd.id);
        return (
          <div key={sd.id} data-testid={`gc-pt-group-${sd.id}`} className="flex flex-col gap-1 rounded-lg border border-border bg-raised p-2.5">
            <div className="flex items-center gap-2">
              <SymbolChip presentation={presentation} id={sd.id} />
              <span className="text-[10px] text-text-3">{sd.role === 'scatter' ? 'pays on total grid count' : 'left-aligned run'}</span>
              <button
                data-testid={`gc-add-pt-row-${sd.id}`}
                onClick={() => applyModel((m) => addPaytableRow(m, sd.id))}
                className="ml-auto rounded border border-border px-2 py-0.5 text-xs text-text-2 hover:bg-raised-hover"
              >
                + row
              </button>
            </div>
            {rows.map(({ e, i }) => {
              const rowIssues = issues.filter((iss) => iss.path === `paytable.entries[${i}]`);
              return (
                <div key={i} data-testid={`gc-pt-row-${i}`} className="flex items-center gap-3 pl-1 text-xs text-text-1">
                  <span className="flex items-center gap-1.5 text-text-2">
                    count{' '}
                    <Stepper value={e.count} min={1} onChange={(v) => applyModel((m) => updatePaytableRow(m, i, { count: v }))} testId={`gc-pt-count-${i}`} />
                  </span>
                  <span className="flex items-center gap-1.5 text-text-2">
                    payout{' '}
                    <CommittedInput
                      testId={`gc-pt-payout-${i}`}
                      value={String(e.payout)}
                      kind="int"
                      onCommit={(v) => applyModel((m) => updatePaytableRow(m, i, { payout: parseInt(v, 10) }))}
                    />
                  </span>
                  <button
                    data-testid={`gc-pt-delete-${i}`}
                    onClick={() => applyModel((m) => removePaytableRow(m, i))}
                    className="rounded px-1.5 py-0.5 text-text-2 hover:bg-raised-hover hover:text-danger"
                  >
                    ✕
                  </button>
                  {rowIssues.map((iss, k) => (
                    <span key={k} data-testid={`gc-pt-issue-${i}`} className={`text-[11px] ${iss.severity === 'error' ? 'text-danger' : 'text-warning'}`}>
                      {iss.message}
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 5: Write BonusSection**

```tsx
// studio/frontend/src/plugins/game-config/sections/BonusSection.tsx
import { gameConfigHooks } from '../state';
import type { ISlotModel } from '../model';
import { applyModel } from '../actions';
import { addBonus, removeBonus, updateBonusConfig, updateBonusTrigger } from '../reducers';
import { validateModel } from '../validate';
import { Stepper } from '../components/Stepper';
import { CommittedInput } from '../components/CommittedInput';

export function BonusSection() {
  const s = gameConfigHooks.usePluginState();
  const model = s.model.get({ noproxy: true }) as ISlotModel;
  const issues = validateModel(model).filter((i) => i.tab === 'bonus');
  const scatters = model.symbols.filter((sd) => sd.role === 'scatter');

  return (
    <div data-testid="gc-section-bonus" className="flex flex-col gap-3 p-3">
      {model.bonuses.map((b, i) => {
        const { trigger, config } = b.FreeSpins;
        const triggerOptions = scatters.some((sd) => sd.id === trigger.symbol) ? scatters : [...scatters, { id: trigger.symbol, role: 'scatter' as const }];
        const cardIssues = issues.filter((iss) => iss.path.startsWith(`bonuses[${i}]`));
        return (
          <div key={i} data-testid={`gc-bonus-card-${i}`} className="flex flex-col gap-2 rounded-lg border border-border bg-raised p-2.5">
            <div className="flex items-center">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Free Spins {i + 1}</span>
              <button
                data-testid={`gc-bonus-delete-${i}`}
                onClick={() => applyModel((m) => removeBonus(m, i))}
                className="ml-auto rounded px-1.5 py-0.5 text-xs text-text-2 hover:bg-raised-hover hover:text-danger"
              >
                ✕
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-xs text-text-2">
              <span className="flex items-center gap-1.5">
                trigger
                <select
                  data-testid={`gc-bonus-trigger-symbol-${i}`}
                  value={trigger.symbol}
                  onChange={(e) => applyModel((m) => updateBonusTrigger(m, i, { symbol: Number(e.target.value) }))}
                  className="h-6 rounded border border-border bg-canvas px-1 text-text-1"
                >
                  {triggerOptions.map((sd) => (
                    <option key={sd.id} value={sd.id}>
                      S{sd.id}
                    </option>
                  ))}
                </select>
              </span>
              <span className="flex items-center gap-1.5">
                min count{' '}
                <Stepper
                  value={trigger.min_count}
                  min={1}
                  onChange={(v) => applyModel((m) => updateBonusTrigger(m, i, { min_count: v }))}
                  testId={`gc-bonus-min-count-${i}`}
                />
              </span>
              <span className="flex items-center gap-1.5">
                spins{' '}
                <Stepper
                  value={config.spins_awarded}
                  min={1}
                  onChange={(v) => applyModel((m) => updateBonusConfig(m, i, { spins_awarded: v }))}
                  testId={`gc-bonus-spins-${i}`}
                />
              </span>
              <span className="flex items-center gap-1.5">
                multiplier{' '}
                <CommittedInput
                  testId={`gc-bonus-multiplier-${i}`}
                  value={String(config.multiplier)}
                  kind="int"
                  onCommit={(v) => applyModel((m) => updateBonusConfig(m, i, { multiplier: parseInt(v, 10) }))}
                />
              </span>
              <label className="flex items-center gap-1.5">
                <input
                  data-testid={`gc-bonus-retrigger-${i}`}
                  type="checkbox"
                  checked={config.retrigger}
                  onChange={(e) => applyModel((m) => updateBonusConfig(m, i, { retrigger: e.target.checked }))}
                />
                retrigger
              </label>
            </div>
            <span data-testid={`gc-bonus-feature-note-${i}`} className="text-[11px] text-text-3">
              Feature strips: {config.feature_reels === null ? 'base reels' : 'custom — edited in the Reels tab'}
            </span>
            {cardIssues.map((iss, k) => (
              <span key={k} data-testid={`gc-bonus-issue-${i}`} className={`text-[11px] ${iss.severity === 'error' ? 'text-danger' : 'text-warning'}`}>
                {iss.message}
              </span>
            ))}
          </div>
        );
      })}
      <button
        data-testid="gc-add-bonus"
        onClick={() => applyModel((m) => addBonus(m))}
        className="self-start rounded border border-border px-3 py-1 text-xs text-text-1 hover:bg-raised-hover"
      >
        + Add free spins feature
      </button>
    </div>
  );
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/plugins/game-config/sections/PaytableSection.spec.tsx src/plugins/game-config/sections/BonusSection.spec.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add studio/frontend/src/plugins/game-config/sections
git commit -m "feat(game-config): paytable + bonus sections"
```

---

### Task 13: JSON section

**Files:**

- Modify: `studio/frontend/src/plugins/game-config/sections/JsonSection.tsx` (replace stub)
- Test: `studio/frontend/src/plugins/game-config/sections/JsonSection.spec.tsx`

**Interfaces:**

- Consumes: `gameConfigHooks`, `applyModelFromJson` (mocked in tests).
- Produces testids: `gc-json-textarea`, `gc-json-apply`, `gc-json-error`. The textarea binds `s.jsonDraft` (kept fresh by `applyModel`); Apply is the ONE explicit-commit exception to save-on-edit. This is the power-edit escape hatch replacing the simulator textarea; it edits `model` only, never `presentation`.

- [ ] **Step 1: Write the failing test**

```tsx
// studio/frontend/src/plugins/game-config/sections/JsonSection.spec.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { rootStore } from '../../../state/rootStore';
import { GAME_CONFIG_PLUGIN_ID, gameConfigSlice, makeInitialState } from '../state';
import { JsonSection } from './JsonSection';

const applyModelFromJson = vi.fn();
vi.mock('../actions', () => ({
  applyModelFromJson: (text: string) => applyModelFromJson(text),
}));

describe('JsonSection', () => {
  beforeEach(() => {
    applyModelFromJson.mockReset();
    rootStore.plugins.nested(GAME_CONFIG_PLUGIN_ID).set(makeInitialState() as never);
    act(() => {
      gameConfigSlice().activeGameId.set('g1');
      gameConfigSlice().jsonDraft.set('{"rows": 3}');
    });
  });

  it('shows the draft and applies it via the Apply button', () => {
    render(<JsonSection />);
    const ta = screen.getByTestId('gc-json-textarea') as HTMLTextAreaElement;
    expect(ta.value).toBe('{"rows": 3}');
    fireEvent.change(ta, { target: { value: '{"rows": 4}' } });
    fireEvent.click(screen.getByTestId('gc-json-apply'));
    expect(applyModelFromJson).toHaveBeenCalledWith('{"rows": 4}');
  });

  it('renders jsonError when set', () => {
    act(() => gameConfigSlice().jsonError.set('Unexpected token'));
    render(<JsonSection />);
    expect(screen.getByTestId('gc-json-error').textContent).toContain('Unexpected token');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/plugins/game-config/sections/JsonSection.spec.tsx`
Expected: FAIL — stub has no textarea.

- [ ] **Step 3: Write the implementation**

```tsx
// studio/frontend/src/plugins/game-config/sections/JsonSection.tsx
import { gameConfigHooks } from '../state';
import { applyModelFromJson } from '../actions';

export function JsonSection() {
  const s = gameConfigHooks.usePluginState();
  const jsonError = s.jsonError.get();

  return (
    <div data-testid="gc-section-json" className="flex h-full flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Model JSON</span>
        <button
          data-testid="gc-json-apply"
          onClick={() => applyModelFromJson(s.jsonDraft.get())}
          className="ml-auto rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary-hover"
        >
          Apply
        </button>
      </div>
      {jsonError && (
        <p data-testid="gc-json-error" className="text-xs text-danger">
          {jsonError}
        </p>
      )}
      <textarea
        data-testid="gc-json-textarea"
        value={s.jsonDraft.get()}
        onChange={(e) => s.jsonDraft.set(e.target.value)}
        spellCheck={false}
        className="min-h-0 flex-1 resize-none rounded border border-border bg-canvas p-2 font-mono text-xs text-text-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/plugins/game-config/sections/JsonSection.spec.tsx`
Expected: PASS.

- [ ] **Step 5: Run the whole plugin suite + frontend gates**

Run: `npx vitest run src/plugins/game-config`
Expected: all green.
Run: `npx nx typecheck frontend`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/plugins/game-config/sections/JsonSection.tsx studio/frontend/src/plugins/game-config/sections/JsonSection.spec.tsx
git commit -m "feat(game-config): raw JSON tab with explicit Apply"
```

---

### Task 14: Backend — presentation field, source label, on_change seam

**Files:**

- Modify: `studio/backend/app/simulator/models.py`
- Modify: `studio/backend/app/simulator/store.py`
- Modify: `studio/backend/app/simulator/rest.py`
- Test: `studio/backend/tests/test_sim_store.py` (append tests)
- Test: `studio/backend/tests/test_sim_rest.py` (append test)

Run all backend commands from `studio/backend/` with `uv run`.

**Interfaces:**

- Consumes: existing `SlotModelDoc`, `SlotModelStore`, `PutSlotModelBody`.
- Produces:
  - `SlotModelDoc.presentation: dict = {}` (wire: `presentation`).
  - `SlotModelStore(db, on_change=None)` where `on_change: async (doc: SlotModelDoc, source: str) -> None`.
  - `SlotModelStore.put(game_id, *, model=None, params=None, presentation=None, source="api")` — fires `on_change(doc, source)` AFTER persisting, only when `model` or `presentation` changed (params-only writes stay silent; `save_result` never fires it).
  - `PutSlotModelBody` gains `presentation: dict | None = None` and `source: str = "api"`; the PUT route passes both through.

- [ ] **Step 1: Append the failing store tests**

Append to `studio/backend/tests/test_sim_store.py`:

```python
@pytest.mark.asyncio
async def test_put_presentation_roundtrip_and_isolation(mongo_db):
    store = SlotModelStore(mongo_db)
    doc = await store.put("g1", presentation={"symbols": {"0": {"label": "Ace", "color": "sym-1"}}})
    assert doc.presentation["symbols"]["0"]["label"] == "Ace"
    # a model-only write must not touch presentation (tuner Apply safety)
    doc = await store.put("g1", model={"rows": 3})
    assert doc.presentation["symbols"]["0"]["label"] == "Ace"
    assert doc.model == {"rows": 3}


@pytest.mark.asyncio
async def test_seeded_doc_has_empty_presentation(mongo_db):
    store = SlotModelStore(mongo_db)
    doc = await store.get_or_seed("g1")
    assert doc.presentation == {}


@pytest.mark.asyncio
async def test_put_fires_on_change_with_source(mongo_db):
    events = []

    async def on_change(doc, source):
        events.append((doc.game_id, source))

    store = SlotModelStore(mongo_db, on_change=on_change)
    await store.put("g1", model={"rows": 1}, source="editor")
    assert events == [("g1", "editor")]
    await store.put("g1", presentation={"symbols": {}}, source="tuner")
    assert events[-1] == ("g1", "tuner")
    # params-only writes and result saves are silent
    await store.put("g1", params=default_params())
    res = CurationResult(
        status="pass",
        metrics=MetricsWire(rtp=0.9, volatility=1.0, hit_frequency=0.2,
                            base_rtp=0.9, feature_rtp=0.0, bonus_hit_rates=[]),
        realized_rtp=0.9, pool_size=10, failure=None, ran_at="t",
    )
    await store.save_result("g1", res)
    assert len(events) == 2
    # default source is "api"
    await store.put("g1", model={"rows": 2})
    assert events[-1] == ("g1", "api")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_sim_store.py -q`
Expected: FAIL — `put() got an unexpected keyword argument 'presentation'` (and missing `on_change`).

- [ ] **Step 3: Implement models.py + store.py**

In `studio/backend/app/simulator/models.py`, add the field to `SlotModelDoc` (after `params`):

```python
class SlotModelDoc(_WireModel):
    id: str
    game_id: str
    model: dict
    params: CurationParams
    presentation: dict = {}  # editor-side symbol labels/colors; opaque here
    result: CurationResult | None = None
    created_at: str
    updated_at: str
```

In `studio/backend/app/simulator/store.py`, replace `__init__` and `put`:

```python
class SlotModelStore:
    def __init__(self, db, on_change=None):
        # on_change: async (doc: SlotModelDoc, source: str) -> None; fired after any
        # model/presentation write. Wired to a socket emit in main.py — the store
        # itself stays socket-free.
        self._docs = db["slot_models"]
        self._on_change = on_change

    async def get(self, game_id: str) -> SlotModelDoc | None:
        raw = await self._docs.find_one({"game_id": game_id})
        return _from_doc(raw) if raw else None

    async def get_or_seed(self, game_id: str) -> SlotModelDoc:
        existing = await self.get(game_id)
        if existing is not None:
            return existing
        now = _now()
        doc = SlotModelDoc(
            id=str(uuid.uuid4()), game_id=game_id, model={}, params=default_params(),
            result=None, created_at=now, updated_at=now,
        )
        await self._docs.insert_one(_to_doc(doc))
        return doc

    async def put(self, game_id: str, *, model: dict | None = None,
                  params: CurationParams | None = None,
                  presentation: dict | None = None,
                  source: str = "api") -> SlotModelDoc:
        await self.get_or_seed(game_id)
        fields: dict = {"updated_at": _now()}
        if model is not None:
            fields["model"] = model
        if params is not None:
            fields["params"] = params.model_dump(mode="json")
        if presentation is not None:
            fields["presentation"] = presentation
        await self._docs.update_one({"game_id": game_id}, {"$set": fields})
        doc = await self.get(game_id)
        if self._on_change is not None and (model is not None or presentation is not None):
            await self._on_change(doc, source)
        return doc
```

(`get_or_seed` and `save_result` are unchanged apart from `__init__`.)

- [ ] **Step 4: Run store tests to verify they pass**

Run: `uv run pytest tests/test_sim_store.py -q`
Expected: PASS.

- [ ] **Step 5: Append the failing REST test**

Append to `studio/backend/tests/test_sim_rest.py`:

```python
@pytest.mark.asyncio
async def test_put_accepts_presentation_and_source(mongo_db):
    events = []

    async def on_change(doc, source):
        events.append(source)

    store = SlotModelStore(mongo_db, on_change=on_change)
    req = _req(sim_store=store)
    body = rest.PutSlotModelBody(
        model={"rows": 2},
        presentation={"symbols": {"0": {"label": "Ace", "color": "sym-1"}}},
        source="editor",
    )
    updated = await rest.put_slot_model("g1", body, req)
    assert updated["presentation"]["symbols"]["0"]["color"] == "sym-1"
    assert events == ["editor"]
    got = await rest.get_slot_model("g1", req)
    assert got["presentation"]["symbols"]["0"]["label"] == "Ace"
```

- [ ] **Step 6: Run to verify it fails, then implement rest.py**

Run: `uv run pytest tests/test_sim_rest.py -q` — Expected: FAIL (unknown fields ignored → no presentation echo, no event).

In `studio/backend/app/simulator/rest.py`, update the body model and PUT route:

```python
class PutSlotModelBody(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    model: dict | None = None
    params: CurationParams | None = None
    presentation: dict | None = None
    source: str = "api"


@router.put("/games/{game_id}/slot-model")
async def put_slot_model(game_id: str, body: PutSlotModelBody, request: Request) -> dict:
    doc = await request.app.state.sim_store.put(
        game_id, model=body.model, params=body.params,
        presentation=body.presentation, source=body.source)
    return sim_wire(doc)
```

- [ ] **Step 7: Run the simulator backend suites**

Run: `uv run pytest tests/test_sim_store.py tests/test_sim_rest.py tests/test_sim_hub.py tests/test_sim_wiring.py -q`
Expected: PASS (hub/wiring untouched but exercised for regressions).

- [ ] **Step 8: Commit**

```bash
git add studio/backend/app/simulator/models.py studio/backend/app/simulator/store.py studio/backend/app/simulator/rest.py studio/backend/tests/test_sim_store.py studio/backend/tests/test_sim_rest.py
git commit -m "feat(simulator): presentation field + slot-model change notification seam"
```

---

### Task 15: Backend — socket emit wiring + source labels on existing writers

**Files:**

- Modify: `studio/backend/app/main.py` (~8 lines, additive)
- Modify: `studio/backend/app/tuner/rest.py:61` (one argument)
- Modify: `studio/backend/app/agent_tools.py:1461` (one argument)
- Test: `studio/backend/tests/test_tuner_rest.py` (append assertion)

**Interfaces:**

- Consumes: `SlotModelStore.on_change` (Task 14), the `sio` server in `main.py::build`.
- Produces: a `slot_model_changed` socket event `{"gameId", "updatedAt", "source"}` emitted to `room=game_id` on every model/presentation write, regardless of writer. Frontend already listens (Task 6) and joins the room via `join_sim`.

- [ ] **Step 1: Wire the emitter in `main.py`**

In `build()`, replace the line `sim_store = SlotModelStore(mongo[settings.mongo_db])` with:

```python
    async def _on_slot_model_change(doc, source: str) -> None:
        # Single choke point: every model/presentation write (editor PUT, tuner
        # apply, agent tools) reaches any open Game Config pane via the game room.
        await sio.emit(
            "slot_model_changed",
            {"gameId": doc.game_id, "updatedAt": doc.updated_at, "source": source},
            room=doc.game_id,
        )

    sim_store = SlotModelStore(mongo[settings.mongo_db], on_change=_on_slot_model_change)
```

- [ ] **Step 2: Label the existing writers**

`studio/backend/app/tuner/rest.py` line 61 — change:

```python
    updated = await request.app.state.sim_store.put(game_id, model=tuned, source="tuner")
```

`studio/backend/app/agent_tools.py` line 1461 (the `apply_tuned_model` tool) — change:

```python
        await ctx.sim_store.put(ctx.game_id, model=tuned, source="tuner")
```

- [ ] **Step 3: Append a tuner-apply source assertion**

In `studio/backend/tests/test_tuner_rest.py`, find the existing apply test (it builds a `SlotModelStore` and calls `rest.apply_tuner` / the apply route). Add a variant that passes an `on_change` recorder into the `SlotModelStore` it constructs and asserts the event source:

```python
@pytest.mark.asyncio
async def test_apply_emits_tuner_source(mongo_db):
    events = []

    async def on_change(doc, source):
        events.append(source)

    # Mirror the existing apply test's arrangement (tuner_store with a tuned
    # result + sim_store), but with the recording sim_store:
    sim_store = SlotModelStore(mongo_db, on_change=on_change)
    # ... (copy the existing test's tuner_store/result setup verbatim) ...
    # after calling the apply route:
    assert events == ["tuner"]
```

Follow the surrounding test's exact fixture pattern when copying the setup — the point of the new test is only the `events == ["tuner"]` assertion.

- [ ] **Step 4: Run the backend suite**

Run: `uv run pytest -m "not e2e" -q`
Expected: PASS — full backend suite green (catches any caller of `SlotModelStore(...)` or `.put(...)` missed by the signature change; both stay backward-compatible).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/main.py studio/backend/app/tuner/rest.py studio/backend/app/agent_tools.py studio/backend/tests/test_tuner_rest.py
git commit -m "feat(simulator): emit slot_model_changed to the game room on every model write"
```

---

### Task 16: Simulator pane slim-down (LAST shared-file touch)

**Files:**

- Modify: `studio/frontend/src/plugins/simulator/SimulatorPane.tsx`
- Modify: `studio/frontend/src/plugins/simulator/state.ts` (drop `modelText`)
- Modify: `studio/frontend/src/plugins/simulator/actions.ts` (drop `modelText` writes)
- Modify: `studio/frontend/src/plugins/simulator/SimulatorPane.spec.tsx`

**PRECONDITION:** run `git fetch origin && git rebase origin/main` first — a concurrent session is working in the simulator area; take their merged changes before touching these files. If the rebase shows changes to these four files, re-read them and adapt.

**Interfaces:**

- Consumes: `curate` (`./restClient`), `getHost` (`../../state/hostRef`) — called lazily in the click handler only (it throws before boot).
- Produces: simulator pane WITHOUT the JSON textarea (`simulator-model-json` testid disappears); `onCurate` no longer parses/PUTs a model — it curates the stored one; a hint (`open-game-config-hint`) opens the Game Config pane.

- [ ] **Step 1: Update the spec first (RED)**

In `studio/frontend/src/plugins/simulator/SimulatorPane.spec.tsx`, add to the existing describe block:

```tsx
it('has no JSON textarea and offers the Game Config hint', () => {
  act(() => {
    simulatorSlice().activeGameId.set('g1');
  });
  render(<SimulatorPane {...({} as never)} />);
  expect(screen.queryByTestId('simulator-model-json')).toBeNull();
  expect(screen.getByTestId('open-game-config-hint')).toBeTruthy();
});
```

Run: `npx vitest run src/plugins/simulator/SimulatorPane.spec.tsx` — Expected: FAIL (textarea still rendered, no hint).

- [ ] **Step 2: Slim the pane**

In `SimulatorPane.tsx`:

- Delete the `const modelText = s.modelText.get();` line and the whole `<textarea …>` block.
- Replace `onCurate` with:

```tsx
async function onCurate() {
  try {
    simulatorSlice().status.set('running');
    simulatorSlice().progress.set({ phase: 'starting', done: null, total: null });
    await curate(activeGameId!);
  } catch (_e) {
    simulatorSlice().status.set('error');
    simulatorSlice().progress.set(null);
  }
}
```

- Remove `putSlotModel` from the `./restClient` import (keep `curate`).
- Add `import { getHost } from '../../state/hostRef';` and, in the header strip next to the title span:

```tsx
<button data-testid="open-game-config-hint" onClick={() => getHost().openPane('game-config/editor')} className="text-xs text-accent-text hover:underline">
  Edit model in Game Config →
</button>
```

- [ ] **Step 3: Drop `modelText` from state + actions**

- `state.ts`: remove `modelText: string;` from `ISimulatorState` and `modelText: '',` from `makeInitialState()`.
- `actions.ts`: remove `s.modelText.set(JSON.stringify(doc.model ?? {}, null, 2));` from `openGameSim` and `s.modelText.set('');` from `closeGameSim`.

- [ ] **Step 4: Verify green + typecheck**

Run: `npx vitest run src/plugins/simulator` — Expected: PASS.
Run: `npx nx typecheck frontend` — Expected: no errors (catches any remaining `modelText` reference).
Run: `grep -rn "simulator-model-json" studio/frontend/src studio/frontend/e2e` — Expected: hits ONLY in `e2e/simulator.spec.ts` (rewritten next task).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/simulator
git commit -m "refactor(simulator): drop JSON textarea; editing moves to Game Config pane"
```

---

### Task 17: Playwright e2e — game-config suite + simulator rewrite

**Files:**

- Create: `studio/frontend/e2e/game-config.spec.ts`
- Modify: `studio/frontend/e2e/simulator.spec.ts` (author via REST, not textarea)

**Setup (worktree, offset 3):** from the worktree root run `just backend-serve-replay` in one shell (starts :8003 with `bloom_studio_wt3`), then `just e2e -- game-config.spec.ts simulator.spec.ts` in another (Playwright starts/attaches the frontend on :4203 via `BLOOM_PORT_OFFSET` from `.env`). The simulator spec shells out to the real curate binary — build it once first with `just sim-build`.

**Interfaces:**

- Consumes: `seedLocalStorage`, `BACKEND_URL` from `./helpers`; the running replay backend; testids from Tasks 8–13 and 16.
- Produces: the authoritative behavioral contract for the editor (per AGENTS.md, the e2e suite outranks prose).

- [ ] **Step 1: Write `e2e/game-config.spec.ts`**

```ts
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { seedLocalStorage, BACKEND_URL as BACKEND } from './helpers';

// Drives the Game Config editor against a running backend + frontend.
// Asserts the persisted end-state via GET (not just UI echoes) per repo testing rules.

const MODEL = {
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

const MODEL_B = { ...MODEL, rows: 4 };

async function getModelDoc(request: APIRequestContext, gameId: string) {
  const resp = await request.get(`${BACKEND}/games/${gameId}/slot-model`);
  expect(resp.ok()).toBeTruthy();
  return (await resp.json()) as { model: typeof MODEL; presentation?: { symbols?: Record<string, { label: string; color: string }> } };
}

async function setupGame(page: Page, request: APIRequestContext, username: string, roomName: string): Promise<string> {
  const resp = await request.post(`${BACKEND}/rooms`, { data: { name: roomName } });
  expect(resp.ok()).toBeTruthy();
  const room = (await resp.json()) as { id: string; gameId: string };
  const put = await request.put(`${BACKEND}/games/${room.gameId}/slot-model`, { data: { model: MODEL } });
  expect(put.ok()).toBeTruthy();
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await expect(page.getByTestId('room-picker')).toBeVisible();
  await page.getByTestId('room-picker').getByText(roomName, { exact: true }).click();
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
  return room.gameId;
}

async function openGameConfig(page: Page) {
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-game-config/editor')).toBeVisible();
  await page.getByTestId('view-open-game-config/editor').click();
  await expect(page.getByTestId('gc-tab-symbols')).toBeVisible();
}

test('header stats reflect the seeded model', async ({ page, request }) => {
  await setupGame(page, request, 'alice', `gc ${Date.now()}`);
  await openGameConfig(page);
  await expect(page.getByTestId('gc-stat-window')).toHaveText('3 × 3');
  await expect(page.getByTestId('gc-stat-symbols')).toHaveText('3');
  await expect(page.getByTestId('gc-stat-lines')).toHaveText('2');
  await expect(page.getByTestId('gc-stat-strips')).toHaveText('5, 5, 5');
});

test('symbol label edit persists presentation and pill returns to saved', async ({ page, request }) => {
  const gameId = await setupGame(page, request, 'bob', `gc ${Date.now()}`);
  await openGameConfig(page);
  await page.getByTestId('gc-symbol-label-0').fill('Ace');
  await page.getByTestId('gc-symbol-label-0').blur();
  await expect(page.getByTestId('gc-sync-pill')).toContainText('saved', { timeout: 5_000 });
  const doc = await getModelDoc(request, gameId);
  expect(doc.presentation?.symbols?.['0']?.label).toBe('Ace');
});

test('composition stepper edits the strip and persists', async ({ page, request }) => {
  const gameId = await setupGame(page, request, 'cara', `gc ${Date.now()}`);
  await openGameConfig(page);
  await page.getByTestId('gc-tab-reels').click();
  await page.getByTestId('gc-lens-composition').click();
  await page.getByTestId('gc-comp-count-0-0-inc').click();
  await expect(page.getByTestId('gc-sync-pill')).toContainText('saved', { timeout: 5_000 });
  const doc = await getModelDoc(request, gameId);
  expect(doc.model.reels[0]).toHaveLength(6);
  expect(doc.model.reels[0].filter((s: number) => s === 0)).toHaveLength(4);
});

test('payline painter persists the repainted line', async ({ page, request }) => {
  const gameId = await setupGame(page, request, 'dan', `gc ${Date.now()}`);
  await openGameConfig(page);
  await page.getByTestId('gc-tab-paylines').click();
  await page.getByTestId('gc-pl-cell-0-1-2').click();
  await expect(page.getByTestId('gc-sync-pill')).toContainText('saved', { timeout: 5_000 });
  const doc = await getModelDoc(request, gameId);
  expect(doc.model.paylines[0]).toEqual([0, 2, 0]);
});

test('JSON Apply replaces the model; invalid JSON persists nothing', async ({ page, request }) => {
  const gameId = await setupGame(page, request, 'eve', `gc ${Date.now()}`);
  await openGameConfig(page);
  await page.getByTestId('gc-tab-json').click();
  await page.getByTestId('gc-json-textarea').fill(JSON.stringify(MODEL_B, null, 2));
  await page.getByTestId('gc-json-apply').click();
  await expect(page.getByTestId('gc-stat-window')).toHaveText('4 × 3');
  await expect(page.getByTestId('gc-sync-pill')).toContainText('saved', { timeout: 5_000 });
  let doc = await getModelDoc(request, gameId);
  expect(doc.model.rows).toBe(4);

  await page.getByTestId('gc-json-textarea').fill('not json at all');
  await page.getByTestId('gc-json-apply').click();
  await expect(page.getByTestId('gc-json-error')).toBeVisible();
  doc = await getModelDoc(request, gameId);
  expect(doc.model.rows).toBe(4); // unchanged
});

test('an external REST write re-hydrates the open pane and flashes the source', async ({ page, request }) => {
  const gameId = await setupGame(page, request, 'fay', `gc ${Date.now()}`);
  await openGameConfig(page);
  await expect(page.getByTestId('gc-stat-window')).toHaveText('3 × 3');
  const put = await request.put(`${BACKEND}/games/${gameId}/slot-model`, {
    data: { model: MODEL_B, source: 'tuner' },
  });
  expect(put.ok()).toBeTruthy();
  await expect(page.getByTestId('gc-sync-pill')).toContainText('updated externally · tuner', { timeout: 5_000 });
  await expect(page.getByTestId('gc-stat-window')).toHaveText('4 × 3'); // converged to the store
});

test('deleting a referenced symbol flags issues on the referencing tabs', async ({ page, request }) => {
  await setupGame(page, request, 'gil', `gc ${Date.now()}`);
  await openGameConfig(page);
  await page.getByTestId('gc-symbol-delete-9').click(); // scatter still used by reels/paytable/trigger
  await expect(page.getByTestId('gc-issues-pill')).toBeVisible();
  await expect(page.getByTestId('gc-tab-dot-paytable')).toBeVisible();
  await expect(page.getByTestId('gc-tab-dot-reels')).toBeVisible();
  await expect(page.getByTestId('gc-tab-dot-bonus')).toBeVisible();
  await page.getByTestId('gc-tab-paytable').click();
  await expect(page.getByTestId('gc-pt-issue-1')).toContainText('unknown symbol');
});

test('simulator pane has no textarea and links to Game Config', async ({ page, request }) => {
  await setupGame(page, request, 'hal', `gc ${Date.now()}`);
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-simulator/viewer').click();
  await expect(page.getByTestId('curate-button')).toBeVisible();
  await expect(page.getByTestId('simulator-model-json')).toHaveCount(0);
  await page.getByTestId('open-game-config-hint').click();
  await expect(page.getByTestId('gc-tab-symbols')).toBeVisible();
});
```

- [ ] **Step 2: Rewrite `e2e/simulator.spec.ts` to author via REST**

The suite keeps its PASS/FAIL curation coverage; only the authoring surface changes (textarea → REST PUT, matching how the editor now owns editing). Make these exact edits:

1. In `setupGame`, extend the existing params PUT to also seed the model:

```ts
const paramsResp = await request.put(`${BACKEND}/games/${room.gameId}/slot-model`, {
  data: { model: MODEL_09, params: FAST_PARAMS },
});
```

2. Replace `openSimulator`'s last line (`waitFor` on `simulator-model-json`) with:

```ts
await page.getByTestId('curate-button').waitFor({ state: 'visible', timeout: 5_000 });
```

3. In both tests, delete the `await page.getByTestId('simulator-model-json').fill(...)` line — the model is already stored; keep the `curate-button` click and all assertions.

- [ ] **Step 3: Run the two suites against the worktree replay stack**

Shell A (worktree root): `just backend-serve-replay`
Shell B (worktree root): `just sim-build && just e2e -- game-config.spec.ts simulator.spec.ts`
Expected: all game-config tests PASS; both simulator tests PASS (PASS + FAIL verdicts).

- [ ] **Step 4: Commit**

```bash
git add studio/frontend/e2e/game-config.spec.ts studio/frontend/e2e/simulator.spec.ts
git commit -m "test(e2e): game-config editor behavioral contract + REST-authored simulator suite"
```

---

### Task 18: Full gates, full e2e, PR

- [ ] **Step 1: Frontend gates** (repo root of the worktree)

```bash
node_modules/.bin/prettier --check .
npx nx typecheck frontend
npx nx test frontend
npx nx build frontend
```

Expected: all four green. Fix formatting with `node_modules/.bin/prettier --write .` if needed.

- [ ] **Step 2: Backend gate**

```bash
cd studio/backend && uv run pytest -m "not e2e" -q
```

Expected: green.

- [ ] **Step 3: Full Playwright suite** (the repo rule: run `just e2e` before every PR — the whole suite, not just the new specs)

Shell A: `just backend-serve-replay` · Shell B: `just e2e`
Expected: no regressions vs the current green baseline (86+ green; the reels/scene specs seed models via agent cassettes and are unaffected, but watch any spec that PUTs `/slot-model` — the new socket emit is additive and must not break them).

- [ ] **Step 4: Rebase + push + PR**

```bash
git fetch origin && git rebase origin/main   # re-run gates if anything shifted
git push -u origin feat/game-config
gh pr create --title "feat(game-config): visual core-config editor plugin" --body "<summary of spec + plan links, test evidence>"
```

Do NOT merge in the implementing session — hand back for review / `/bloom:complete-work`.

---

## Self-review notes (already applied)

- Spec coverage: store `presentation` + choke-point event (T14–15), endpoints reuse (T14), pane shell + stat tiles + two pills (T8), all six sections (T9–13), debounced live save + echo/external/watermark/flash (T6), focused-field guard (T7 CommittedInput), simulator slim-down + hint (T16), e2e contract incl. external-write sync and validation dots (T17), `--sym-*` tokens + guard/tokens specs (T2), sequencing constraint (task order + T16 precondition).
- Deliberate simplifications vs spec prose: strip drag-reorder is native HTML5 DnD covered by reducer unit tests (`moveStripCell`), not e2e (DnD e2e is flaky); the paylines "overview grid" shows per-cell line counts rather than overlaid colored paths (density check, YAGNI); a freshly added symbol needs no presentation write — it renders via the deterministic `S<id>` + `id % 10` swatch fallback until the user names/colors it (`nextFreeSwatch` backs the swatch picker's suggestion).
- Type consistency spot-checks: `ReelSetRef` select encoding `bonus-{i}` ↔ `Number(value.slice(6))`; `watermark` compared lexicographically (ISO-8601 UTC strings from one backend clock — safe); `putSlotModel` patch always carries `source`; `StatusPill` spreads `...rest` so `data-testid` lands on the element.

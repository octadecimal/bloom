# Param Sidebar Second Pass — design

**Date:** 2026-07-05
**Status:** approved (brainstormed with user)
**Scope:** `studio/frontend` only — no backend, wire, or Rust changes.
**Builds on:** `2026-07-05-math-param-sidebar-design.md` (merged as PR #153).

## Problem

The first-pass param sidebar (PR #153) shipped four rough edges:

1. **Fixed width.** `w-60` (240px) is hardcoded in `ParamSidebar.tsx`; long
   labels truncate and there is no way to trade chart space for param space.
2. **Math-only shell.** The toggle + persisted visibility live inside the math
   plugin, so the next plugin that wants a params column re-implements them.
3. **Flat, lopsided grouping.** Tuner is a 9-field wall; the groups mirror the
   wire payloads (`tuner_params` / `params`), not how a designer thinks.
4. **No header hierarchy.** Group headers and field labels share the exact
   same styling (10px uppercase `text-2`), so groups don't read as a tier
   above fields.

## Decisions (user-confirmed)

- **Shell shape:** hook + 2 components in `components/ui/` (no context, no
  shadcn-style provider tree). Rejected: shadcn primitive set (ceremony for
  one consumer), resize-only-without-extraction (skips goal 2).
- **Grouping:** 6 semantic groups (below). Rejected: minimal Tuner-only split,
  two-level Generate/Verify nesting.
- **Hierarchy:** PanelHeader pattern — headers move to `text-1` + hairline
  divider; field labels unchanged. Rejected: demoting field labels to sentence
  case (bigger visual change than needed).

## Architecture

### 1. Shared shell — new `components/ui/PaneSidebar.tsx`

Three exports; the math plugin composes them, the registry stays math-owned.

- `usePaneSidebar(storageKey: string, opts?: { defaultWidth?: number })` →
  `{ open, toggle, width, setWidth }`.
  - Persists `{ open, width }` as JSON under the **existing** key
    (`bloom.math.sidebar` for math — key unchanged so users keep their state).
  - Tolerant parse: legacy `'1'` / `'0'` values map to the open flag with
    default width; malformed values fall back to `{ open: false, width: 240 }`.
  - Width clamped to **200–420**; default **240**.
- `<PaneSidebar width onWidthChange>` — the right column shell:
  `flex-none overflow-y-auto border-l border-hairline`, inline `width` style,
  children = plugin content. Its left edge carries the **resize handle**:
  ~6px hit area straddling the hairline, `hover:bg-hairline-strong` (matches
  the Dockview resizer sash convention), pointer-capture drag (left = wider),
  `role="separator"` `aria-orientation="vertical"` with ArrowLeft/ArrowRight
  keyboard resize (step ~16px), `data-testid="sidebar-resize"`.
- `<PaneSidebarToggle open onToggle icon title testId>` — the ghost icon
  button extracted from MathPane's current toggle: `aria-pressed`,
  `text-accent-text` when open, `hover:bg-raised-hover`.

Math wiring: `MathPane` swaps `useParamSidebarOpen` (deleted) for
`usePaneSidebar('bloom.math.sidebar')` and renders
`ParamSidebar` inside `<PaneSidebar>`. Testids `advanced-toggle` (toggle) and
`advanced-params` (sidebar body) are preserved.

### 2. Regrouping — `paramFields.ts` only

`IParamGroup` becomes
`'search' | 'genetics' | 'weights' | 'verification' | 'pool' | 'repro'`.
Field defs are only re-tagged; keys, labels, tooltips, constraints, accessors
all unchanged.

| Group (label)                | Fields (in order)                                              |
| ---------------------------- | -------------------------------------------------------------- |
| `search` Search budget       | population, generations, search-spins, final-spins, stagnation |
| `genetics` Genetic operators | mutation, crossover, elitism                                   |
| `weights` Fitness weights    | weight-rtp, weight-volatility, weight-hit-rate                 |
| `verification` Verification  | candidates, rtp-tolerance, bonus-tolerance                     |
| `pool` Pool                  | pool-size, correction-band                                     |
| `repro` Reproducibility      | master-seed, sim-seed                                          |

`resetGroup` is field-driven and works unchanged across the
`tunerParams`/`curationParams` slice boundary (Reproducibility resets one
field in each slice). Reset testids follow the new ids
(`param-reset-search`, …); the old `param-reset-tuner|weights|curation` ids
are removed — update any test that references them.

### 3. Header hierarchy — `ParamSidebar.tsx` only

Group header rows keep `text-[10px] uppercase tracking-wide` but move
`text-text-2` → `text-text-1`, and gain a hairline divider under the header
row (the PanelHeader pattern). Field labels stay 10px uppercase `text-2`.
No new tokens; the raw-color guard stays green.

## Data flow (unchanged)

Edits write the hookstate slice exactly as before; params ride the existing
PUT-before-Generate/Verify. The shell is pure UI preference state
(localStorage), never game data.

## Behavior details

- Dragging clamps live to 200–420 and writes through `setWidth` (persisted on
  every change — localStorage writes are cheap at drag frequency; no debounce
  unless it visibly janks).
- Keyboard: handle is focusable; ArrowLeft/ArrowRight adjust width by 16px
  within clamps.
- Charts already reflow on resize (resize-aware since PR #149), so dragging
  the sidebar narrows the tab content live with no extra work.

## Testing

Unit (TDD, vitest):

- `PaneSidebar.spec.tsx` — hook: persists open+width round-trip, legacy
  `'1'`/`'0'` migration, malformed-value fallback, width clamping; component:
  drag and keyboard resize call `onWidthChange` with clamped values; toggle:
  `aria-pressed` reflects state.
- `ParamSidebar.spec.tsx` (updated) — renders 6 group headers in order,
  per-group reset restores that group's defaults (incl. cross-slice repro
  group), header styling tier (class assertion).
- `paramFields.spec.ts` (updated) — completeness check re-pointed at the 6
  groups; every field belongs to a declared group.
- `MathPane.spec.tsx` (updated) — toggle still works via the shared shell.

E2e (Playwright, replay backend, worktree offset ports):

- Existing sidebar tests keep passing (testids preserved).
- New: open sidebar → drag `sidebar-resize` → reload → width persisted;
  assert the 6 group headers are visible.

Gates: `node_modules/.bin/prettier --check .`, `npx nx typecheck|test|build
frontend` (unit gates with `BLOOM_PORT_OFFSET=0`), design-language guard
spec, `just e2e` against a replay backend on the worktree's offset ports.

## Error handling

Unchanged — the shell only touches localStorage (wrapped in the tolerant
parse); field validation and network behavior are untouched.

## Out of scope

- Collapse/expand per group, double-click-to-reset width.
- Adopting the shell in other plugins (they adopt when they need a sidebar).
- Any wire/backend change.

# Game Config Visual Editor — Design

**Date:** 2026-07-02
**Status:** Approved design, not yet built
**Scope decision:** Editor for `slots@1` as-is. No schema evolution.

## Goal

A studio plugin (`game-config`) that visually edits a game's core math
configuration — symbols, reels, window, paylines, paytable, bonus — replacing the
raw JSON `<textarea>` in the simulator pane. The persisted `slot_models` document
remains the single source of truth: the tuner's Apply, the GDD realizer, agent
tools, and raw REST calls keep writing it, and an open editor pane visibly
converges to whatever they write.

## Decisions (from brainstorm)

| Question         | Decision                                                                                                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema scope     | `slots@1` exactly as the kernel defines it. Named reel/paytable sets and all-ways evaluation are out of scope (see Non-goals).                                                                      |
| Old textarea     | Removed. Simulator pane keeps params/Curate/results; editing moves here.                                                                                                                            |
| Write model      | Live doc: debounced auto-save + socket re-hydration on external writes. No Save button.                                                                                                             |
| Symbol display   | Editor-side presentation map (label + color token) stored beside the model, outside the kernel schema.                                                                                              |
| Validation       | Client-side structural checks; invalid states saveable but flagged. Rust serde at curate time remains the authoritative gate.                                                                       |
| Reel editing     | Two lenses: ordered Strip view + symbol×reel Composition matrix.                                                                                                                                    |
| V1 extras        | Raw JSON tab, payline grid painter, derived quick-stats. No undo/redo.                                                                                                                              |
| Backend approach | Extend `app/simulator` (existing owner of `slot_models`). A dedicated `app/game-config` backend was deferred — tracked as [octadecimal/bloom#134](https://github.com/octadecimal/bloom/issues/134). |

## Non-goals

- No `slots@2` / kernel changes: no named reel-set or paytable-set libraries, no
  ways/all-ways evaluation, no new bonus feature types.
- No server-side model validation endpoint.
- No revision counter / ETag conflict resolution (last-write-wins, made visible).
- No undo/redo.
- No coupling to asset-board art (symbols render as labeled color chips, not
  generated thumbnails).

## Data model & backend

### Store doc extension

The `slot_models` document gains one sibling field next to `model` / `params`:

```jsonc
{
  "presentation": {
    "symbols": {
      "0": { "label": "Ace", "color": "sym-1" },
      // keyed by symbol id (stringified), sparse
    },
  },
}
```

- `color` is a **token role name** (`sym-1` … `sym-10`), never a raw color. The
  swatch palette is defined once as `--sym-*` tokens in
  `studio/frontend/src/styles.css` (the design-language guard allows raw colors
  only there). The editor offers the fixed swatch set — no free color picker.
- `presentation` lives outside `model`, so the tuner's Apply (which rewrites
  `model` wholesale) and Rust serde round-trips never see or destroy it.
- Fallback for symbols with no entry: label `S<id>`, deterministic auto-assigned
  swatch (`sym-{(id % 10) + 1}`).
- Python: `SlotModelDoc` gains `presentation: dict = {}`; `SlotModelStore.put`
  accepts an optional `presentation=` kwarg. Additive; existing docs are valid.

### Sync event

`SlotModelStore.put` becomes the single choke point: after persisting, it
notifies via an injected callback (wired in `main.py`, matching existing hub
patterns — the store itself stays socket-free), which emits
**`slot_model_changed`** to the game's socket room:

```jsonc
{ "gameId": "...", "updatedAt": "...", "source": "editor" | "tuner" | "realizer" }
```

Because tuner Apply, the GDD realizer, and the editor all funnel through `put`,
every write path reaches an open pane with no per-caller work. Callers pass their
`source`; unspecified callers default to `"api"`.

### Endpoints

Reuse and extend the existing simulator REST — no new endpoints:

- `GET /games/{id}/slot-model` — response now includes `presentation`.
- `PUT /games/{id}/slot-model` — body accepts optional `model` and/or
  `presentation` (partial update, same pattern as today's optional
  `model`/`params`).

The backend continues to treat `model` as an opaque dict.

## Frontend plugin

### Structure (mirrors `plugins/tuner/`)

```
studio/frontend/src/plugins/game-config/
  index.ts          IPlugin: id 'game-config', pane 'game-config/editor',
                    command 'game-config/open-editor'
  state.ts          IGameConfigState + makePluginHooks slice
  actions.ts        openGameConfig(gameId), save orchestration
  restClient.ts     getSlotModel / putSlotModel
  socketClient.ts   slot_model_changed subscription → re-hydrate
  reducers.ts       pure model transforms (add symbol, set count, resize, …)
  validate.ts       pure slots@1 invariant checks → IValidationIssue[]
  config.ts         BACKEND_URL
  GameConfigPane.tsx
  sections/         SymbolsSection, ReelsSection, PaylinesSection,
                    PaytableSection, BonusSection, JsonSection
```

Registered in `plugins/index.ts`. Operates on the active game like the
tuner/simulator panes. All interfaces `I`-prefixed per coding standards.

### Pane layout — cockpit shell (math-analytics visual style)

```
┌──────────────────────────────────────────────────────────┐
│ HEADER STRIP  game · quick-stat tiles · sync StatusPill  │  natural height
├──────────────────────────────────────────────────────────┤
│ Symbols │ Reels │ Paylines │ Paytable │ Bonus │ JSON     │  tab bar
├──────────────────────────────────────────────────────────┤
│ active section — fills pane, scrolls internally          │  flex-1
└──────────────────────────────────────────────────────────┘
```

- **Header strip**: derived quick-stats as `Card` stat tiles (`text-2` uppercase
  labels, headline numbers): window size (rows × reels), symbol count, strip
  lengths, payline count — plus two `StatusPill`s: sync state (`saved ✓` /
  `saving…` / `updated externally · <source>`) and, when present, an issue
  count (`N issues`, warning tone).
- **Tabs**: accent-underline active signal; tabs with validation issues show a
  small warning dot.
- Styling: design-language tokens and `components/ui` primitives only
  (`bg-surface`, hairline dividers, ghost `Button`s, at most one accent action
  per region, `PanelHeader` for sub-sections). New tokens: `--sym-*` swatches
  only, in `styles.css`.
- Deviation from the math-analytics dashboard's fill-to-pane rule: sections
  **may scroll internally** (long reel strips require it); the shell stays fixed.

### Sections

**Symbols.** Rows of: swatch (fixed `--sym-*` palette picker) · label input ·
role select (`normal / wild / scatter`) · id badge · delete. "Add symbol" takes
the next free id and an unused swatch. Deleting a still-referenced symbol is
allowed but flags issues on the referencing tabs.

**Reels.** Segmented toggle `Strip | Composition`, both lenses over the same
data:

- _Strip view_ — one chip column per reel; chip click → insert/replace/remove
  popover; drag to reorder; `+` at column foot; strip length per column.
- _Composition view_ — symbol × reel matrix of count steppers. Increment appends
  the symbol to that reel's strip; decrement removes the **last occurrence**;
  existing order otherwise preserved. Footer: strip lengths + per-symbol
  frequency %.
- _Reel-set selector_ at tab top: `Base` plus one entry per bonus carrying
  `feature_reels`; actions "add feature strips for FreeSpins" (clones base) and
  "revert to base" (`feature_reels: null`).
- _Window config_ lives here: rows stepper and reel-count stepper. Changing reel
  count resizes `reels` and every payline (validation flags what broke);
  changing rows re-renders payline grids and flags out-of-range indices.

**Paylines.** A list of payline cards, each a rows × reels mini-grid painter:
click a cell to set that reel's row (exactly one selected cell per column,
accent-tinted selection token). Add / duplicate / delete; lines numbered. A
compact overview grid overlays all lines for a density check.

**Paytable.** Table grouped by symbol: `symbol chip · count stepper · payout
input` (integer bet-multiples, `u64`). "Add row" per symbol. Annotations:
scatter rows "pays on total grid count", line symbols "left-aligned run".
Inline warnings for duplicate `(symbol, count)` pairs and zero payouts.

**Bonus.** FreeSpins card(s): trigger symbol select (filtered to scatters) +
min-count stepper, `spins_awarded`, `multiplier`, `retrigger` toggle, and a
read-only pointer to feature reels ("edited in Reels"). Add/remove feature.
Wire shape note: `BonusFeature` is an externally-tagged serde enum —
`{ "FreeSpins": { trigger, config } }`.

**JSON.** Monospace `<textarea>` (`font-mono text-xs`, no editor dependency in
v1) showing the pretty-printed `model`. Two-way: visual edits refresh it; typed
JSON is committed via an explicit **Apply** button (the one exception to
save-on-edit — large text edits shouldn't auto-save mid-thought) — parse errors
inline, valid JSON replaces the working model and saves. This is the power-edit escape hatch replacing the simulator
textarea. It edits `model` only (not `presentation`).

### Validation (`validate.ts`)

Pure function over the model, run on every change; issues carry
`{ tab, path, severity, message }` and drive inline messages, tab warning dots,
and the header count. Checks:

- every payline's length equals reel count; every row index `< rows`
- symbols referenced by reels, paytable, and triggers exist in `symbols`
- duplicate symbol ids; duplicate `(symbol, count)` paytable rows
- trigger symbol has scatter role; `min_count ≥ 1`
- no empty reel strips; `rows ≥ 1`; at least one reel
- integer bounds (`u8` symbol ids and counts, `u64` payouts/multipliers,
  `u32` spins) and non-negative integers everywhere

Invalid states persist normally — the store is a working doc; Rust at curate
time is the final gate.

## Save & sync behavior

- **Saving:** every committed edit (chip dropped, stepper clicked, input
  blurred) updates local state, re-validates, and schedules a **debounced PUT
  (~600 ms)** of the changed field(s) (`model` and/or `presentation`). Pill:
  `saving…` → `saved ✓`. Burst edits collapse into one PUT.
- **Own echo:** `slot_model_changed` with `source: 'editor'` confirms the save
  (pill state only) — it does not re-hydrate, so in-flight typing is never
  clobbered by our own write.
- **External writes** (`tuner` / `realizer` / `api`): fetch the doc, replace
  local model state, re-validate, flash `updated externally · <source>` for a
  few seconds. Last write wins; the pane always converges to the store.
- **Focused-field guard:** if an external write lands while a text input is
  focused mid-edit, that single field keeps its local value until blur (then
  saves normally — that field's value wins for that field only). Everything
  else re-hydrates.
- **Ordering:** the client tracks the `updatedAt` it last hydrated and ignores
  older events, so out-of-order socket delivery cannot regress the pane.
- **Race honesty:** simultaneous editor-vs-tuner writes are last-write-wins at
  the doc level — the store's existing semantics. The socket event makes it
  visible; a revision counter is explicitly out of scope.

## Simulator pane change

`SimulatorPane.tsx` loses `modelText`, the textarea, and its PUT call. It keeps
game selection, curation params, Curate, and results (Curate already reads the
stored model server-side). A small hint links to the editor via
`host.openPane('game-config/editor')`.

## Work sequencing (concurrent-session hygiene)

Another session is actively working in the simulator area. Ordered to touch
shared files last and minimally:

1. Greenfield first: `plugins/game-config/*`, `validate.ts`, all tests.
2. Backend additive diffs: `app/simulator/{models,store,rest}.py`, hub wire-up
   in `main.py` (hot file — keep the diff to a few lines).
3. `SimulatorPane.tsx` textarea removal **last**, after rebasing on whatever the
   simulator session has merged.

Standing rules apply: dedicated worktree (`bloom.wt/game-config`,
`BLOOM_PORT_OFFSET=3`), rebase `main` often, short-lived branch.

## Testing

### Unit (TDD)

- **vitest:** `validate.ts` (every invariant, valid + invalid fixtures);
  `reducers.ts` (strip↔composition round-trips — decrement removes last
  occurrence, order preserved; payline resize on reel-count change; symbol
  add/delete ripple); JSON parse/apply; presentation fallback (label `S<id>`,
  deterministic swatch).
- **Python:** store `presentation` round-trip, partial PUT semantics, change
  notification fired with correct `source` on every write path.

### E2e (Playwright, replay backend — the behavioral contract)

Asserting persisted end-state + UI reconciliation, never dispatch:

- Open pane → header stats match the seeded model.
- One edit per tab → GET shows the doc changed and the UI reconciles.
- Strip and Composition views agree after edits in each.
- Payline painter: click cells → persisted line matches.
- JSON tab: paste a model → visual tabs reflect it; invalid JSON → inline
  error, nothing persisted.
- External-write sync: test PUTs via REST (simulating tuner/agent) → open pane
  re-hydrates and shows `updated externally`.
- Validation: break an invariant → tab dot + inline message + header count.
- Simulator pane: textarea gone; Curate still works against an editor-saved
  model.
- Design guard stays green (`--sym-*` tokens only in `styles.css`).

## Reference

- Kernel schema: `trusted/math/src/mechanics/slots/model.rs` (`SlotModel`,
  `SymbolDef`, `Paytable`, `BonusFeature`); eval invariants in
  `.../slots/eval.rs`.
- Store: `studio/backend/app/simulator/store.py` (`SlotModelStore`,
  `slot_models` collection); wire models in `.../models.py`.
- Plugin template: `studio/frontend/src/plugins/tuner/`.
- Visual language: `docs/design-language.md`, tokens in
  `studio/frontend/src/styles.css`; cockpit-shell precedent in
  `docs/superpowers/specs/2026-07-02-math-analytics-dashboard-design.md`.
- Deferred backend carve-out: [octadecimal/bloom#134](https://github.com/octadecimal/bloom/issues/134).

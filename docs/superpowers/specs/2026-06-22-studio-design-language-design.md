# Studio Design Language — One Enforced System (Linear/Floating-Card)

**Date:** 2026-06-22
**Status:** Design (approved, pre-plan)
**Scope:** `studio/frontend` only — the token layer in `styles.css`, the Dockview
theme, a small set of UI primitives, and the migration of every visible component
onto them. Plus a committed **source of truth** (`docs/design-language.md` +
mockups + reference screenshot) and a **fidelity gate**. No backend / protocol /
state / reducer changes.

## Problem

Three visual passes (PRs #38 "dark game-editor identity", #39 "de-generic craft
pass", #40 "seamless docked panels") each re-skinned the studio, yet the live UI
still reads as **inconsistent and "AI-generated"**. Concretely:

1. **Too many greys.** ~6 ad-hoc surface colors (`#0d1014`, `#161b22`, `#1c222b`,
   `#232a34`, …) plus two kinds of border (hex `#283039` / `#313a47`). Nothing
   says which grey a given element is allowed to use, so every component picks its
   own and the surfaces never line up.
2. **The active tab doesn't read as part of its pane.** The orange top-cap +
   shared surface was a partial fix; the tab still floats apart from the body.
3. **Accent overuse.** Orange appears on competing buttons and decoration, so it
   stops meaning "primary".
4. **No source of truth.** Each session re-guessed the intent from the previous
   diff, so the design drifted a little further every pass. There is no canonical
   reference that future sessions are obligated to follow.

The root cause is not the palette — it is the **absence of one enforced design
language**. This spec establishes that language, migrates every surface onto it,
and makes both adherence and fidelity-to-mockup **mechanically verifiable**.

## Decisions (approved during brainstorming)

- **North-star:** Linear / Vercel — refined modern-SaaS dark. Near-black canvas,
  translucent-white hairlines, restrained elevation, accent used sparingly.
- **Panel model:** "Floating cards" (model C). Each Dockview group is a rounded,
  hairline-bordered card floating on the canvas with a visible gap between groups;
  the active tab is marked by a wrapped underline. **This supersedes PR #40's
  "seamless" model** — a conscious reversal.
- **Ambition:** full design-system + fidelity gate (not another in-place restyle).
- **Accent stays fire-orange** (`#f0641e`) — only the structure/restraint changes.

Approved mockups are committed beside this spec:
`docs/design-language/mockup-tokens.html`,
`docs/design-language/mockup-panel-model.html` (direction C),
`docs/design-language/mockup-directions.html`.

## The token system (the cure)

Exactly **4 surfaces, 2 hairline weights, 3 text tiers, 1 accent**. Nothing in the
app may use a color that is not one of these names. Values are authoritative.

### Surfaces — 4 elevations, nothing between

| Token            | Value     | Use                                                          |
| ---------------- | --------- | ------------------------------------------------------------ |
| `--canvas`       | `#08090a` | app bg · the gap between floating panels · inset field wells |
| `--surface`      | `#131417` | the floating panel card body · active tab shares this        |
| `--raised`       | `#1b1c1f` | cards / tiles / inputs sitting on a surface                  |
| `--raised-hover` | `#232427` | hover state for raised things & menu items                   |

Elevation only ever moves canvas → surface → raised → raised-hover, never sideways.

### Hairlines — translucent white, exactly 2 weights (the Linear signature)

| Token               | Value                    | Use                                                   |
| ------------------- | ------------------------ | ----------------------------------------------------- |
| `--hairline`        | `rgba(255,255,255,0.07)` | every default border: panels, cards, fields, dividers |
| `--hairline-strong` | `rgba(255,255,255,0.12)` | hover/emphasis, resizer, ghost-button edge            |

No more hex-grey borders (`#283039`, `#313a47`).

### Text — 3 tiers only

| Token      | Value     | Use                              |
| ---------- | --------- | -------------------------------- |
| `--text-1` | `#ededef` | primary content                  |
| `--text-2` | `#9b9ba4` | secondary text, uppercase labels |
| `--text-3` | `#62626b` | faint / placeholder / disabled   |

### Accent — fire orange, rationed

| Token            | Value                   | Use                                |
| ---------------- | ----------------------- | ---------------------------------- |
| `--accent`       | `#f0641e`               | the rationed accent (see rule 3)   |
| `--accent-hover` | `#ff7a33`               | hover/active of accent fills       |
| `--accent-text`  | `#ff8a4d`               | orange text/icons on dark surfaces |
| `--accent-fg`    | `#160a02`               | text on an accent fill             |
| `--selection`    | `rgba(240,100,30,0.14)` | selected-row / active tint         |
| `--success`      | `#3ec28b`               | status                             |
| `--warning`      | `#e7b549`               | status                             |
| `--danger`       | `#f0574d`               | errors (e.g. "generation failed")  |

### The four rules (this is what kills the AI-generated look)

1. **4 surfaces, full stop.** No component invents a 5th grey.
2. **Every border is a hairline** — one of the two white-alpha weights. No hex-grey borders.
3. **Accent is rationed.** Orange appears only on: active-tab underline · focus
   ring · selected row · and **exactly one primary action per context** (no two
   competing primary-weight buttons in one region). Everything else is a ghost
   button. Orange is never decoration.
4. **3 text tiers only.** Labels are text-2 uppercase; placeholders text-3.

### Token plumbing

`styles.css` is the **machine source of truth**. The new tokens are declared in
`:root` and exposed to Tailwind via `@theme inline` (as today). The existing
**legacy shadcn remap** (`--background`, `--muted`, `--border`, `--primary`, …) is
re-pointed onto the new ramp so utility classes and the `components/ui/*` layer
inherit the language without per-component edits:
`--background → --surface`, `--muted → --raised`, `--accent(hover) → --raised-hover`,
`--border → --hairline`, `--primary → --accent`, `--destructive → --danger`,
`--foreground → --text-1`, `--muted-foreground → --text-2`, `--input → --hairline`,
`--ring → --accent`. Dark-only today; a future light theme supplies a second
value-set for the same names with no component changes.

## Dockview floating-card model

Dockview 6.6.1 supports this natively — no CSS hacks.

- **Migrate from class-only theming to a typed `DockviewTheme` object.** Today
  `useApplyTheme` only adds `dockview-theme-bloom`. `gap` is a layout value (it
  changes the grid math), so it must come through the theme object. Define
  `bloomTheme: DockviewTheme` and pass it via `<DockviewReact theme={bloomTheme} />`.
  Derive it from the official `themeAbyssSpaced` (a proven "Spaced"/floating-card
  base), overriding only colors/radius onto our tokens.
- **`gap: 8`** → real spacing between panel cards; `--canvas` shows through the gap.
- **`tabGroupIndicator: 'wrap'`** → Chrome-style rounded underline wrapping the
  active tab (the model-C active signal).
- **Per-group CSS on `.dockview-theme-bloom`:** group body bg = `--surface`,
  `border: 1px solid var(--hairline)`, `border-radius: 9px`; tab strip bg =
  `--surface`; sash/gap transparent (canvas shows through); resizer hover =
  `--hairline-strong`; active-tab underline = `--accent`; active/visible tab bg =
  `--surface` so tab + pane read as one card.

Net: each group is a rounded, hairline-bordered card floating on the canvas with
an 8px gutter — matching mockup C — and it stays correct through drag/split
because `gap` is native.

## Component primitives

Every surface routes through a small set of styled primitives (in
`studio/frontend/src/components/ui/`, props `I`-prefixed per coding standards) that
encode the rules, so components stop hand-rolling colors.

| Primitive                          | Definition                                                                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `PanelHeader` _(exists — retoken)_ | uppercase `--text-2` label, bottom hairline, optional right slot                                                                              |
| `Card`                             | `--raised` bg, hairline border, radius 8px — the asset tiles                                                                                  |
| `Field` (Input + Textarea)         | `--raised` bg, hairline border, radius 6px, `--text-3` placeholder, **`--accent` focus ring**                                                 |
| `Button`                           | variants: `primary` (accent fill + `--accent-fg`), `ghost` (transparent + `--hairline-strong` border + `--text-1`), `subtle` (icon/text only) |
| `Pill`                             | `--raised`-subtle bg, `--text-2`, rounded-full — `connected` / `AI: idle` / mode badge                                                        |

Tabs are produced by the Dockview theme, not a React primitive.

### Migration map (components that currently set their own colors)

- `AssetBoardPane` → `Card` + `Field` + `Button` (Generate = `primary`, Delete =
  `ghost`) + `--danger` for "generation failed"; add-asset form's create button is
  its region's one primary.
- `ChatRoomPane` / `SettingsPane` → `Pill` + token text tiers; assistant marked
  with `--accent-text` + faint rule (no loud disk).
- `Menubar`, `CommandPalette`, `SwitchUser`, `ModeBadge`, `SaveLayoutDialog` →
  tokens + `Pill`/`Button`.
- demo panes (`CounterPane`, `MirrorPane`, `ScratchPane`) → tokens (they're
  visible, so they count).
- `components/ui/*` (shadcn) → the legacy var remap routes most of it; tighten the
  few spots that bypass tokens.

## Source of truth

Two layers, both committed, so future sessions are obligated to follow the language:

1. **Machine:** the `:root` token layer in `studio/frontend/src/styles.css`.
2. **Human/agent:** `docs/design-language.md` — the 4 surfaces, 2 hairlines, 3 text
   tiers, the 4 rules, the primitive catalog, and an embedded reference screenshot.
   **Linked from `AGENTS.md`** next to `docs/coding-standards.md` so it loads into
   every future session's context automatically (the same mechanism that makes the
   `I`-prefix rule stick). The approved mockup HTML lives under
   `docs/design-language/` as the visual reference.

## Fidelity gate

Three layers, cheap → strong, respecting the repo CI-cost policy (browser e2e stays
local; only the cheap check gates CI).

1. **No-raw-color check (CI-affordable).** A test that scans
   `studio/frontend/src` for any hex literal or non-token `rgba()` **outside
   `styles.css`**; must return zero. Mechanical guarantee that components cannot
   drift back to ad-hoc colors. Cheap enough to gate every PR.
2. **Computed-style assertions in Playwright (local, source of truth).**
   `e2e/theme.spec.ts` asserts _invariants_ against the real running shell (not
   pixels — pixel snapshots are brittle across fonts/AA):
   - Docked groups are floating hairline cards: `border-radius: 9px`, `1px`
     border, `border-color: rgba(255,255,255,0.07)`.
   - The `--canvas` token resolves to `#08090a`.
   - A reference screenshot of the workbench is captured (committed fidelity
     artifact).

   The **accent-rationing rule (rule 3)** is enforced by the `Button` variant
   system + the no-raw-color guard (layer 1) + code review + the committed
   reference screenshot — not by an e2e assertion today. Future hardening:
   per-element invariants (active-tab underline = accent, Field focus ring =
   accent, one accent-filled button per region) could be added to
   `theme.spec.ts`.

3. **Reference screenshot artifact (human eyeball).** One Playwright step captures
   the real workbench (top bar + Chat Room + Asset Board, replay backend) to a PNG
   committed under `docs/design-language/`. The approved mockup sits beside it; any
   future visual change re-shoots it and the diff is reviewable in the PR.

Run via `just e2e` (replay backend) before every PR (consistent with the
always-run-e2e rule). CI runs only layer 1.

## Deliverables

- Token layer rewritten in `styles.css` (+ legacy remap re-pointed).
- `bloomTheme: DockviewTheme` object + `useApplyTheme`/`Workbench` migration to the
  `theme` prop (`gap: 8`, `tabGroupIndicator: 'wrap'`).
- Primitive catalog (`Card`, `Field`, `Button`, `Pill`, retoken `PanelHeader`) +
  component migration per the map.
- `docs/design-language.md` (canonical, linked from `AGENTS.md`) + committed
  mockups + reference screenshot.
- 3-layer fidelity gate.

## Non-goals

- No backend/protocol/state/reducer changes.
- No light theme yet (token names are structured to allow one later).
- No new panes, features, or layout behavior — visual language only.
- No unrelated refactoring beyond routing components onto the primitives.

## Testing

- **TDD** for primitives and the no-raw-color check (unit, CI-affordable).
- **Playwright** `theme.spec.ts` extended with the computed-style invariants and
  the reference screenshot step (local, the behavioral source of truth).
- `just e2e` against the replay backend before any PR.

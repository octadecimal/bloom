# Workbench UX pass 3 — expandable navigation rail

**Date:** 2026-07-14
**Status:** Approved design, pre-implementation
**Scope:** `studio/frontend` shell only. Follow-up to
[pass 2](2026-07-14-workbench-navrail-design.md) (PR #208), which shipped the
icon-only rail.

## Problem

The rail is icon-only; pane identity rests on icon recognition and hover
tooltips. New users (and anyone facing 12 icons) need a readable map. The rail
should expand to icon + label and collapse back, remembering the choice.

## Design

All changes live in `studio/frontend/src/app/NavRail.tsx`. `Workbench.tsx`,
`IPaneDef`, the View menu, the command palette, and Dockview persistence are
untouched.

### 1. State & persistence

- One boolean `expanded`, default `false` (collapsed).
- Persisted to localStorage key `bloom.navRailExpanded` (`'1'` / absent); read
  once on mount via lazy `useState` initializer, written on every toggle.
- Default-collapsed keeps e2e runs and fresh sessions pixel-identical to the
  shipped rail — no widening of issue #207's width-marginal blast radius.

### 2. Geometry & transition

- Collapsed: `w-10` (40px, unchanged). Expanded: `w-44` (176px — fits the
  longest pane title, "Property Inspector", at `text-xs` with a 16px icon and
  row padding).
- `transition-[width] duration-150` on the nav; the nav gets
  `overflow-hidden` and rows use `whitespace-nowrap` so labels clip cleanly
  mid-transition instead of wrapping.
- The rail stays in normal flex flow (pushes the Dockview area, no overlay);
  Dockview already handles container resize.
- `aria-expanded` on the toggle button reflects the state (the ARIA-correct
  host — `aria-expanded` belongs on the controlling element, not the `<nav>`).

### 3. Rows

`RailButton` becomes a full-width row when expanded:

- `h-8` row (unchanged height); 16px icon in a fixed `w-8` slot so icon
  centerlines never move between states; pane title in `text-xs` beside it.
- Collapsed rendering is pixel-identical to the shipped rail.
- State tiers unchanged, now reading across the whole row: active →
  `bg-selection text-foreground` (the "selected row" accent slot — exactly what
  `--selection` is rationed for), open → `text-foreground`, closed →
  `text-muted-foreground`, hover → `bg-raised-hover hover:text-foreground`.
- Native `title` tooltip only when collapsed (redundant beside a visible
  label); `aria-label` kept always.

### 4. Group labels

- Expanded: uppercase `--text-2` (`text-muted-foreground`) `text-[10px]`
  labels — `DESIGN`, `ART`, `MATH` — above each curated group, replacing the
  hairline dividers. Mirrors the PhaseSwitcher's journey phases and the design
  language's label pattern ("Labels are text-2 uppercase").
- Collapsed: hairline dividers exactly as today.
- The uncurated overflow group (future plugins, dev demo panes) gets no label;
  it keeps a hairline divider in both states.
- Utility group: no label, stays bottom-anchored after the flex spacer.

### 5. Toggle

- Bottom-pinned below the utility group, separated by a hairline divider.
- lucide `PanelLeftOpen` (collapsed) / `PanelLeftClose` (expanded) icon, same
  32px row treatment as pane buttons, `text-muted-foreground` with the usual
  hover tier; label "Collapse" when expanded.
- `data-testid="rail-toggle"`; `title`/`aria-label` "Expand navigation" /
  "Collapse navigation".

### 6. Design-language conformance

No new heights, borders, colors, or text tiers: same right hairline, same
`--canvas` bg, the three existing text tiers, `--selection` for active,
`--raised-hover` for hover. `styles.css` unchanged; the no-raw-color guard
stays green by construction.

## Out of scope (follow-ups)

- Hover-to-peek expand, per-group collapse, drag-to-resize width — add if the
  fixed width ever pinches.
- Issue #200 (inactive→active engine-iframe reload) and #207 (width-marginal
  full-suite flake) remain their own issues.

## Testing

- Unit (`NavRail.spec.tsx`): toggle flips the width class and persists to
  localStorage; a persisted `'1'` mounts expanded; labels and group headers
  render only when expanded; collapsed keeps dividers and no visible labels;
  toggle testid/aria state; existing open/active/click coverage still passes in
  both states.
- E2e (one new spec, worktree offset ports): rail starts collapsed; clicking
  `rail-toggle` shows pane labels; reload preserves the expanded state;
  toggling back restores icon-only. The rest of the suite runs with the
  collapsed default (localStorage clean per test context).
- Full `just e2e` (replay backend, `BLOOM_PORT_OFFSET=1` ports) before PR.
  `docs/design-language/reference-workbench.png` should be byte-stable — the
  collapsed default is visually unchanged; if the shot differs, commit the
  re-shoot with the PR.

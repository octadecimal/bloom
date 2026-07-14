# Workbench UX pass 2 — navigation rail

**Date:** 2026-07-14
**Status:** Approved design, pre-implementation
**Scope:** `studio/frontend` shell only. Follow-up to
[pass 1](2026-07-14-workbench-ux-pass1-design.md) (PR #198), which deferred the
icon-rail sidebar.

## Problem

Panes are launched through the View menu or the command palette — both hidden
behind a click or a keystroke. There is no always-visible map of the workbench:
nothing shows what panes exist, which are open, or which is active. The rail
gives the shell a persistent, one-glance launcher (the Linear/VS Code
activity-bar pattern) without touching the View menu that 29 e2e specs depend
on.

## Design

### 1. `NavRail` component

New `studio/frontend/src/app/NavRail.tsx`, rendered in `Workbench.tsx` to the
left of the Dockview area, below the full-width toolbar:

```
toolbar ────────────────────────────
rail │ dockview panels
```

- ~40px wide column, `--canvas` bg (shell chrome, like the toolbar), hairline
  right border.
- One icon button per `host.listPanes()` entry: lucide icon at 16px, native
  `title` tooltip with the pane title, `data-testid="rail-open-<paneId>"`.
- Click → `host.openPane(id)` (existing create-or-focus semantics).
- Bottom-anchored utility group after a flex spacer.

### 2. Curation map (approach A — central, not a plugin API)

The rail owns a single `id → { icon, group }` map for the known panes. The
journey grouping needs central curation anyway, so icons live in the same
place; `IPaneDef` is unchanged and no plugin files are touched.

| Group              | Panes (order)                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| design             | `llm-chat/room` (MessageSquare), `gdd/viewer` (FileText)                                                          |
| art                | `game/preview` (Gamepad2), `property-inspector/panel` (SlidersHorizontal), `assets/board` (Images), `scene-graph/tree` (ListTree), `region-overrides/preview` (LayoutTemplate) |
| math               | `game-config/editor` (Settings2), `game-structure/editor` (Network), `math/viewer` (Sigma)                        |
| utility (bottom)   | `llm-chat/settings` (Settings), `llm-chat/skill-editor` (SquarePen)                                               |

Hairline dividers between groups. Panes not in the map (future plugins, the
dev-only demo panes) append to the end of the top stack before the spacer,
rendering the first letter of their title as the icon — the rail never hides a
registered pane.

### 3. `openPane` already-active guard (root fix, all callers)

`host.openPane` currently calls `existing.api.setActive()` even when the panel
is already the active tab, which reattaches the pane DOM and reloads the engine
iframe (issue #200's no-op case). Add one guard in `host.ts`:

```ts
if (existing) {
  if (!existing.api.isActive) existing.api.setActive();
  return;
}
```

Every caller (rail, View menu, palette) benefits. The inactive→active reload
remains issue #200's scope, not this pass.

### 4. Open/active state

The rail is honest about state (unlike the deliberately stateless
PhaseSwitcher, this state cannot lie — it mirrors Dockview):

- Pane open → icon `--text-1`; closed → `--text-2`; hover → `--raised-hover`
  bg + `--text-1`.
- Active panel → `--selection` bg tint (the "selected row" slot in the
  accent-rationing rule; no new colors, guard test stays green).
- Reactivity: the rail reads the Dockview API through the same `getApi` ref the
  host uses and subscribes to `onDidLayoutChange` + `onDidActivePanelChange`,
  bumping a version counter. Before the API attaches, icons render in the
  closed state.

### 5. Untouched

View menu (`view-open-*` testids), command palette, PhaseSwitcher, Dockview
layout persistence, `IPaneDef`.

## Out of scope (follow-ups)

- Issue #200 proper (inactive→active engine-iframe reload on re-activation).
- Toggle-to-close on active icon click (VS Code behavior); click is
  open/focus only.
- Room picker upgrades; active-phase tracking (carried from pass 1).

## Testing

- Unit: `NavRail` renders curated order with group dividers; unknown pane falls
  to the trailing slot with letter fallback; click calls `host.openPane`;
  open/active styling tracks a fake Dockview api. `host.openPane` no-ops when
  the panel is already active (new), still focuses when inactive, still creates
  when missing.
- E2e: one new spec — rail visible with `rail-open-*` buttons; clicking
  `rail-open-math/viewer` opens the Math pane; the active tint follows the
  active panel. Existing `theme.spec.ts` + no-raw-color guard cover styling.
- Full `just e2e` (replay backend, worktree offset ports) before PR — this
  re-shoots `docs/design-language/reference-workbench.png` (the rail changes
  the reference; the new PNG is committed with the PR).

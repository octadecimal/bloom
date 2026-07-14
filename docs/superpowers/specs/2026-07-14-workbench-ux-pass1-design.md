# Workbench UX pass 1 — journey phases + shell cleanups

**Date:** 2026-07-14
**Status:** Approved design, pre-implementation
**Scope:** `studio/frontend` shell only. The icon-rail sidebar is explicitly a
follow-up pass, not this slice.

## Problem

The Workbench default layout shows Chat Room + Chat Settings + Asset Board;
everything else (Game Scene, GDD, Game Config, Math, …) hides behind the View
menu — a flat, registration-ordered dropdown that still lists demo panes in
production. The north-star moment ("a game appears from a conversation and then
bends to it", `docs/north-star.md` §3) has no expression in the UI: the game
itself is invisible until hunted down, and the journey's phases (design → art →
math → play) don't exist as navigation.

## Design

### 1. Journey-phase layout presets

Replace the `Chat` / `Focus` builtins in
`studio/frontend/src/app/layoutPresets.builtins.ts` with four presets matching
the authoring journey. Chat is the control surface, so it is docked left in
every phase:

| Preset     | Layout                                                   |
| ---------- | -------------------------------------------------------- |
| **Design** | Chat \| GDD viewer                                       |
| **Art**    | Chat \| Game Scene (Inspector right) / Asset Board below |
| **Math**   | Chat \| Game Config \| Math                              |
| **Play**   | Chat (narrow) \| Game Scene (dominant)                   |

Pane ids: `llm-chat/room`, `gdd/viewer`, `game/preview`,
`property-inspector/panel`, `assets/board`, `game-config/editor`,
`math/viewer`.

No new machinery: entries in the existing `LAYOUT_BUILTINS` map, applied
through the existing builtin semantics (`api.clear()` + rebuild,
`layoutPresets.ts`). User-saved arrangements are untouched.
`e2e/layout-presets.spec.ts` references the old builtin names and gets updated.

### 2. Toolbar phase switcher

New `PhaseSwitcher` component rendered in the top strip's empty flex space
(`Workbench.tsx`): a segmented control of four text buttons — Design, Art,
Math, Play — each calling `presets.apply(name)`. Styling follows
`docs/design-language.md` (hairline-bordered segment group, no new colors).

Deliberately **stateless**: no "active phase" highlight, because the layout
drifts the moment the user rearranges panes and a lying highlight is worse
than none. The Layout menu keeps listing all presets (builtins + user), so
nothing is lost for muscle memory or tests.

### 3. Default layout = Art phase

`DEFAULT_LAYOUT` (`studio/frontend/src/app/workbenchSetup.ts`) delegates to
the Art preset builder instead of duplicating its own pane list. First run and
"Reset layout" both show chat + the living game + assets — the magic moment —
and there is exactly one definition of that arrangement.

### 4. Shell cleanups

- **Demo panes out of prod.** `demoCounter` and `demoScratch` are appended to
  `PLUGINS` only when `!import.meta.env.PROD` (same guard pattern as
  `__injectPlugins` in `setupApp.ts`).
- **Palette discoverability.** A small "Commands ⌘K" hint button in the
  toolbar opens the existing command palette (today Ctrl/⌘-K is the only,
  invisible, entry point).
- **Palette auto-lists panes.** `CommandPalette` renders an "Open <title>"
  entry for every `host.listPanes()` result directly; the ~10 hand-written
  per-plugin `*/open-*` commands are deleted. This frees plugin commands for
  real actions later. The View menu and its `view-open-*` testids are
  **untouched** — 29 e2e specs open panes through them.

## Out of scope (follow-ups)

- Icon-rail sidebar replacing/augmenting the View menu (next pass, only if the
  itch survives the presets).
- Room picker upgrades (recency sort, game badge, delete/rename).
- Active-phase tracking in the switcher.

## Testing

- Unit: `PhaseSwitcher` renders 4 phases and click applies the preset;
  `CommandPalette` lists an Open entry per registered pane; builtin presets
  produce their pane sets against a Dockview test api.
- E2e: update `layout-presets.spec.ts` builtin names; one new assertion that
  clicking a phase button lands that phase's panes. Demo-pane gating is
  dev-only behavior — assert prod exclusion at unit level (vite define), not
  e2e.
- Full `just e2e` (replay backend, worktree offset ports) before PR.

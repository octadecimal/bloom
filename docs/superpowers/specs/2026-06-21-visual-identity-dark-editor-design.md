# Bloom Studio — Visual Identity (Dark Game-Editor)

**Date:** 2026-06-21
**Status:** Design (pre-plan, awaiting user review)
**Scope:** `studio/frontend` only — design tokens (`styles.css`), the `components/ui`
primitives, a small set of new chrome components, the Dockview theme, and a re-skin
pass across the existing panes/routes. **No backend, protocol, state-shape, or
behavior changes.** This is a visual-identity layer on top of the structure delivered
by the prior premium-UX work (PRs #31, #33, #34).

## Problem

The studio's structure is sound — tokens, `components/ui` primitives, consistent
empty/loading/error states — but its **visual identity is the default shadcn/Tailwind
look**, which reads as "AI-generated" rather than premium:

- **Color:** the primary is `oklch(0.55 0.2 264)` — a generic indigo/violet, the most
  clichéd "AI app" accent. Neutrals are pure chroma-0 grays (no tint, no warmth).
- **Shape & elevation:** undifferentiated `rounded-md`/`rounded-lg` corners and default
  `shadow-sm`. No considered radius or elevation system.
- **Scale:** `h-12` header, `h-9` controls, `p-4` everywhere, `text-base`/`text-sm`.
  Everything is too big and uniformly spaced — no density rhythm.
- **Cohesion:** each pane improvises its own density and surface treatment; the active
  Dockview tab does not visually connect to the pane it opens.

The prior "premium UX" passes were explicitly **structural** and listed "no
theme/visual-identity redesign" as a non-goal. So the actual look-and-feel has never
been designed. This spec designs it.

The target, chosen with the user: a **dark-first, compact game-editor** aesthetic in the
lineage of Unity / Unreal / Blender / Godot — dense panels, hairline framing, one
confident accent reserved for active/primary affordances.

## Goals

1. **Replace the token layer** with a semantic, dark-first system: a cool-slate neutral
   ramp on a three-step elevation model (gutter → surface → raised), a fire-orange
   accent, and a compact density + radius + type scale.
2. **Add the missing chrome** that makes the studio read as an editor: a `PanelHeader`,
   a custom **Dockview theme** with **connected tabs** (active tab shares the pane
   surface, recessed inactive tabs on the gutter), surface utilities, thin scrollbars,
   and status pills.
3. **Retune the `components/ui` primitives** (`button`, `input`, `select`, `card`) to the
   compact scale and new tokens.
4. **Re-skin every existing surface** — chat, Asset Board, Settings, RoomPicker, Login,
   Workbench titlebar, ModeBadge — onto the new system, so the whole product reads as one
   instrument.
5. **Self-host IBM Plex Sans + IBM Plex Mono** for reliable, FOUT-free typography.
6. Preserve **every load-bearing test hook and all behavior**; the existing unit + e2e
   contracts stay green (they key off testids/roles/structure, not colors).
7. Keep the system **dark-only now but light-ready**: components reference semantic
   tokens only, so a future light theme is an added value-set, not a refactor.

## Non-goals (YAGNI)

- **No backend / protocol / state / reducer / render-isolation changes.** Pure
  presentation.
- **No new features** — no new panes, no message editing/threading/reactions, no asset
  categories, no settings beyond what exists.
- **No light theme authored now.** Only the _seam_ is preserved (semantic tokens). The
  `ThemeToggle` UI is removed; the theming mechanism is not.
- **No user-facing density toggle now.** Density ships as a fixed compact baseline,
  tokenized so a toggle is cheap later.
- **No layout/navigation restructure**; Dockview, routes, command palette, menubar, and
  layout presets keep their behavior.
- **No motion system** beyond the existing simple `transition-colors` on interactive
  elements.

## Current architecture (reference)

Unchanged except where noted.

- **Tokens:** `studio/frontend/src/styles.css` — Tailwind v4 `@theme inline`, oklch
  tokens in `:root` + `.dark`, importing `dockview-react/dist/styles/dockview.css`.
- **Primitives:** `components/ui/` — `button.tsx` (CVA; `default`/`outline`/`ghost`/
  `destructive`, sizes `default`/`sm`/`icon`), `input.tsx`, `select.tsx`, `card.tsx`,
  `dialog.tsx`, `menubar.tsx`, `command.tsx`, `sonner.tsx`. `lib/utils.ts` → `cn()`.
- **Shell:** `app/Workbench.tsx` (titlebar over `DockviewReact`), `app/Menubar.tsx`,
  `app/ThemeToggle.tsx`, `app/ModeBadge.tsx`, `app/SwitchUser.tsx`,
  `app/CommandPalette.tsx`, `app/useApplyTheme.ts`.
- **Panes/routes:** `plugins/llm-chat/` (`ChatRoomPane` → `MessageList` →
  `ChatMessageBubble` + status sub-components; `SettingsPane`), `plugins/assets/`
  (`AssetBoardPane`, `AssetCard`), `app/routes/RoomPicker.tsx`, `app/routes/LoginScreen.tsx`.
- **Render isolation:** `app/renderCount.ts` `bumpRenderCount`; `MessageList` subscribes
  to `messages.length` only; `ChatMessageBubble` to its own leaves. **Invariant — must
  not regress.**

## Design

### 1. Design tokens (`styles.css`)

Semantic names only — components never reference raw colors or Tailwind palette names.
Values below are the designed (dark) values as hex for precision; they are authored in
`styles.css` in oklch per the repo convention (hex equivalents kept as comments). A
future light theme supplies a second value-set for the same names — no component churn.

**Neutral ramp — cool slate, three elevations:**

| Token             | Hex       | Role                                                                |
| ----------------- | --------- | ------------------------------------------------------------------- |
| `--bg` (gutter)   | `#0d1014` | app background, gaps between panels, tab-strip gutter, inset fields |
| `--surface`       | `#161b22` | pane/working surface; the active tab shares this                    |
| `--raised`        | `#1c222b` | controls, tiles, cards on a surface                                 |
| `--raised-hover`  | `#232a34` | hover for raised elements                                           |
| `--border`        | `#283039` | hairline dividers and outlines                                      |
| `--border-strong` | `#313a47` | emphasized separators (e.g. resizers)                               |
| `--text`          | `#e7eaef` | primary text                                                        |
| `--muted`         | `#8a93a2` | secondary text, labels, inactive tabs                               |
| `--faint`         | `#5c6573` | disabled / placeholder                                              |

**Accent — fire orange (reserved for active + primary only):**

| Token                 | Hex                     | Role                                                         |
| --------------------- | ----------------------- | ------------------------------------------------------------ |
| `--accent`            | `#f0641e`               | primary buttons, active-tab cap, focus ring                  |
| `--accent-hover`      | `#ff7a33`               | hover/active state of accent fills                           |
| `--accent-foreground` | `#2a1002`               | text/icon on an accent fill                                  |
| `--accent-text`       | `#ff8a4d`               | accent-colored text/icons on dark surfaces                   |
| `--selection`         | `rgba(240,100,30,0.15)` | selected-row / active tint (use `color-mix` from `--accent`) |
| `--selection-text`    | `#ffb98c`               | text on a selected row                                       |

**Status:** retune existing `--destructive` for the slate surface (a clear red that
reads on `--surface`); add `--success` (`#3ec28b`-ish) and `--warning` (`#e7b549`-ish)
for connection/mode pills. All exposed via `@theme inline` as `--color-*` so
`bg-*`/`text-*`/`/NN` opacity utilities work.

**Tailwind mapping:** `@theme inline` maps every token to `--color-<name>`. The legacy
names still referenced by components (`--background`, `--foreground`, `--primary`,
`--popover`, `--muted`, `--accent` as currently used, `--input`, `--ring`) are **kept as
aliases** onto the new ramp so nothing breaks mid-migration, then collapsed as panes are
re-skinned. (Note: the new `--accent`/`--raised` differ in meaning from shadcn's
`--accent`; the migration renames usages explicitly to avoid the collision.)

**Dark as default:** dark values live in `:root` (not only under `.dark`). The
`useApplyTheme`/`.dark` mechanism is retained but always-dark; a future light theme adds
a `:root[data-theme='light']` (or re-homes the current values under `.dark`) value-set.

### 2. Density, radius & type scale

A **4px grid**. Compact baseline, tokenized (`--space-1: 4px` … or Tailwind spacing
utilities used consistently) so a future density toggle rescales in one place.

- **Control heights:** `sm` 22px, `default` 24px (`h-6`), `lg` 28px (`h-7`). Header/
  titlebar 32–36px.
- **Padding/gap:** field padding `3px 7px`; list-row padding `3–4px 7px`; list gap 3px;
  content padding 8px; panel-header padding `6px 9px`.
- **Radii:** `--radius-sm` 2px (tiles, chips), `--radius` 4px (default: buttons, inputs,
  rows), `--radius-md` 6px (panels, cards, tabs), `--radius-full` (dots, avatars).
- **Type scale:** label 10px / `letter-spacing:.9px` / uppercase / `--muted`; base 12px;
  secondary 11px; pane/section headings 14px; hero/empty-state headings 16–17px;
  `font-weight` 500 default, 600–700 for headings/active.
- **No drop-shadows.** Elevation is communicated by the three background steps + hairline
  borders, never by `box-shadow`. (Focus rings and the active-tab cap are the only
  "lifts".)

### 3. Shape, surface & chrome model

The cohesion rule, applied uniformly:

- **Three elevations only:** `--bg` (gutter, recessed) → `--surface` (working pane) →
  `--raised` (controls/tiles). Nothing else.
- **Panels float as bordered surfaces over the gutter:** `bg-surface border border-border
rounded-md`, separated by gutter gaps.
- **Panel header (`PanelHeader`):** a new component — uppercase 10px `--muted` label, a
  hairline bottom border, an optional right-aligned slot (e.g. `game: skybloom`), on the
  panel's own surface (no clashing fill).
- **Connected tabs (Dockview theme):** the **active tab shares `--surface` and drops the
  border between itself and the pane**, so tab + pane are one continuous shape; a **2px
  `--accent` cap** marks active without recoloring; **inactive tabs are transparent on the
  `--bg` gutter** with `--muted` text. This directly fixes the floating-active-tab issue.
- **Thin scrollbars:** custom `::-webkit-scrollbar` (and Firefox `scrollbar-*`) — ~8px,
  `--raised` thumb on transparent track, editor-style.
- **Status pills:** small dot + label badges (connection, AI status, `ModeBadge`) using
  `--success`/`--warning`/`--muted` on a subtle `--raised` chip.

### 4. Chrome components & primitives

**New:**

- `components/ui/PanelHeader.tsx` — `IPanelHeaderProps { label, right? }`; the labeled
  surface header used by every pane's content.
- **Dockview theme** — a project stylesheet (e.g. `styles/dockview-bloom.css`) overriding
  the `--dv-*` variables (tab background/active/hover, border, gap, group/panel
  background) to realize §3's connected tabs + gutter; replaces the default
  `dockview.css` theme import. (Behavior/markup of Dockview unchanged — theme only.)
- Optional `components/ui/StatusPill.tsx` if the pill recurs enough to factor out.

**Retuned (no API change unless noted):**

- `button.tsx` — heights to the compact scale; `default` = `--accent` fill /
  `--accent-foreground`, hover `--accent-hover`; `outline`/`ghost`/`destructive` retoned;
  focus-visible ring = `--accent`. `IButtonProps` unchanged.
- `input.tsx`, `select.tsx` — compact height, `--bg`/`--border`, focus ring `--accent`.
- `card.tsx` — `--surface`/`--border`, `--radius-md`, **drop `shadow-sm`**, compact
  padding. (Used by Settings, RoomPicker, AssetCard.)
- `menubar.tsx`, `dialog.tsx`, `command.tsx`, `sonner.tsx` — token + density pass.

### 5. Typography delivery

Self-host via `@fontsource/ibm-plex-sans` + `@fontsource/ibm-plex-mono` (or the variable
packages), imported in `main.tsx`/`styles.css`. Tokens `--font-sans` (`'IBM Plex Sans',
system-ui, sans-serif`) and `--font-mono` (`'IBM Plex Mono', ui-monospace, monospace`),
mapped in `@theme inline`. Mono is used for technical/numeric content: asset dimensions,
seeds, model ids, timestamps, latency, IDs.

### 6. Surface re-skin (per pane)

All **preserve testids, roles, `data-*` hooks, and behavior**:

- **Workbench titlebar** — compact (32–36px), `--bg`/`border-b`, brand + `AppMenubar` +
  status cluster (`ModeBadge`/`SwitchUser`), `--font-sans`. **Remove `ThemeToggle`** from
  the cluster and delete the component; the preserved "light-ready seam" is the semantic
  tokens themselves, not a runtime toggle.
- **Chat** (`ChatRoomPane` + `MessageList` + `ChatMessageBubble` + status lines) — slate
  surface; author-labeled feed retuned to compact (avatar color stays derived from
  `author`); composer = compact `Input`; `ErrorBanner` on `--destructive`; status as pills.
  **Render-isolation invariant preserved** (no new pane-level content subscription;
  `bumpRenderCount` names unchanged).
- **Asset Board** (`AssetBoardPane`, `AssetCard`) — `PanelHeader` + compact tile grid;
  selects via `Select`; error text `--destructive`; full-size viewer retuned.
- **Settings** (`SettingsPane`) — `Card` + `PanelHeader` + `Select`, compact.
- **RoomPicker / LoginScreen** — centered card, compact `Input`/`Button`; loading/error/
  empty on tokens; **e2e selectors preserved** (placeholder `/new room/i`, button
  `/create/i`, exact room-name text).
- **ModeBadge** — `StatusPill` treatment.

## E2E & test plan (source of truth)

Per AGENTS.md, the Playwright suite is the behavioral contract and is **local-only**
(`just e2e` against a replay backend; `just e2e-live` on demand). The redesign is
visual, so the contract is **preservation**: all existing specs
(`llm-chat.spec.ts`, `routing.spec.ts`, `layout*.spec.ts`, `dockview.spec.ts`,
asset-board specs) **must stay green unchanged** — they assert testids/roles/structure,
not colors.

New/expanded assertions (keyed to stable hooks, never color values):

1. **Connected tab** — the active Dockview tab carries a stable active marker
   (class/`data-` hook) and the inactive tabs do not; switching tabs moves it.
2. **Compact density** — a representative control (e.g. `chat-send`) resolves to the
   compact height class hook; `chat-messages`/asset grid remain scrollable
   (`overflow-auto`).
3. **PanelHeader** — panes render their labeled header (testid e.g. `panel-header`).
4. Existing chat-polish/error/settings/room-picker assertions from the prior spec remain.

## Testing strategy

- **Unit (vitest, TDD, CI):** token-class/variant rendering for retuned `button`/
  `input`/`select`/`card`; `PanelHeader` (label + right slot); chat tests (render
  isolation intact, testids, `data-role`/`data-status`, streaming caret); `SettingsPane`,
  `RoomPicker` state rendering. Behavior tests unchanged.
- **E2e (Playwright):** the contract above; exhaustive per AGENTS.md; local-only.
- **Verification before completion:** `prettier --check .`, nx typecheck, vitest, build,
  backend pytest, then `just e2e` (replay) green — output shown before any completion
  claim. (Per the frontend CI gates: prettier + typecheck + test + build must all pass,
  not just vitest.)

## Execution approach

- **TDD throughout** — failing unit test before each layer's implementation; e2e expanded
  to encode the connected-tab/density/header hooks.
- **subagent-driven-development** (repo default) — fresh implementer subagent per task, a
  task review after each, a whole-branch review at the end.
- **Build order:** (1) tokens + fonts + density/radius scale (with legacy aliases) →
  (2) Dockview theme + connected tabs → (3) primitives retune + `PanelHeader` →
  (4) Workbench titlebar + status pills + scrollbars → (5) pane re-skins (chat → assets →
  settings → room-picker → login) → (6) remove `ThemeToggle`, collapse legacy aliases →
  (7) e2e sweep + a dark-theme contrast/eyeball pass.
- **Branch/PR:** `feat/visual-identity-dark-editor`; semantic commits; squash-merge via PR
  (main is protected).

## Open risks

- **Dockview theming limits.** The connected-tab look depends on what `--dv-*` variables
  expose; if a seam (e.g. the exact active-tab/pane border join) isn't reachable via
  variables, fall back to scoped CSS overrides on Dockview's stable class names. Validate
  the active-tab/pane merge early (build step 2) before the wider re-skin.
- **Render-isolation regression** in the chat re-skin — mitigated by keeping the component
  split and `bumpRenderCount` names; the existing unit test is the guard.
- **Token-rename churn.** Repurposing `--accent` (shadcn hover-surface → our orange) can
  silently mis-color components mid-migration; mitigated by the explicit alias layer and
  renaming usages pane-by-pane.
- **Font loading / self-host wiring** with Vite/nx — verify `@fontsource` resolves in the
  build and the mono actually applies to technical content; check bundle size.
- **Contrast at compact sizes** — fire orange `--accent-foreground` and `--muted` text
  must clear contrast at 11–12px; eyeball and nudge oklch lightness if needed.

```

```

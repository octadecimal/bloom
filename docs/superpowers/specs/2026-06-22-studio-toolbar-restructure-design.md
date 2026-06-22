# Studio Toolbar Restructure — Zoned, In-Language Top Bar

**Date:** 2026-06-22
**Status:** Design (approved, pre-plan)
**Scope:** `studio/frontend` chrome only — the top toolbar and the four controls it
hosts. **No routing or behavior changes** beyond the toolbar. The single data touch
is read-only: surfacing the active room's name + whether a game is linked, both of
which `RoomRoute` already fetches.

## Problem

The top toolbar (`Workbench.tsx`, `h-9`) is a flat, unzoned row that drifted from the
design language ([`docs/design-language.md`](../../design-language.md)):

1. **The Layout/View menus render inside a bordered raised box.** `Menubar` Root is
   `rounded-md border border-border bg-background p-1` at `h-10` — taller than the
   `h-9` toolbar and visually a floating slab, not part of the bar. Triggers are
   `px-3 py-1.5` with no icons.
2. **"Switch user" is a raw unstyled `<button>`** bypassing the token system entirely.
3. **No zone structure.** Brand, navigation, room context, status, and identity all
   sit in one undifferentiated `gap-2` row; the back-to-rooms affordance is a raw
   `← Rooms` `<Link>`. Hover states and control heights are inconsistent.

The brief is a **fuller restructure** (not a consistency pass): deliberate zones, a
real brand mark, menu iconography, and a proper room-context lockup — expressive but
chrome-only.

## Goals

- Reorganize the toolbar into **four deliberate zones** on `--canvas` at a single
  control rhythm.
- Add an ownable **brand mark** and a **breadcrumb room-context lockup** showing the
  real room name + a game-linked chip.
- **De-box** the menus into borderless hover-highlight triggers with icons, and give
  the dropdown a clean in-language popover.
- Route **Switch user** through the `Button` primitive.
- Stay strictly within the design language (4 surfaces · 2 hairlines · 3 text tiers ·
  1 rationed accent) and pass the no-raw-color guard.
- Preserve every existing `data-testid` and accessible-name contract the test suites
  depend on (see **Test Contract**).

## Non-Goals (YAGNI)

- No new menus, dropdowns, or actions. The user control stays a **single** switch-user
  action — **no** identity dropdown (the chevron from early mockups is dropped).
- No routing changes, no new panes, no command-palette changes.
- No token additions or value changes. No backend/protocol/state changes.
- No `activeRoom.ts` change — see Architecture (room data flows through the existing
  `Workbench` chrome prop, which `RoomRoute` already populates).

## Approved Visual Direction

Settled via the visual companion: **Direction B (three zones, divided)**, **40px**
height, **"b" monogram** brand mark, **user control A** (name + ghost switch icon).

```
┌ 40px ─────────────────────────────────────────────────────────────────────────────┐
│ [b] Bloom Studio │ ▦ Layout  ▤ View          Rooms / Verdant Hollow [▮ Game] │ ●REPLAY  (a) ada ⤴ │
│  └─ brand ──────┘  └─ menus ─┘                └──── room context ───────────┘   └── status/identity ─┘│
└─────────────────────────────────────────────────────────────────────────────────────┘
   bg = --canvas, no bottom border (panels float below)
```

### Zones (left → right)

1. **Brand.** `BrandMark` (20px `bg-primary` tile, `text-primary-foreground` "b"
   monogram, `rounded-[6px]`) + `Bloom Studio` wordmark — kept as an `<h1>`,
   `text-[13px] font-semibold` `text-foreground`. Then a vertical hairline divider.
   - The monogram tile is the **only** accent fill in the bar (rule 3 honored). It is
     a **solid** `bg-primary` fill, not a gradient (token-only, guard-safe).
2. **Menus.** `Layout` and `View` triggers, borderless, `h-7`, `gap-1.5`, leading
   lucide icon + label. Idle = `text-muted-foreground`; hover/open =
   `text-foreground` on `bg-raised-hover`. Icons: `LayoutGrid` (Layout),
   `PanelsTopLeft` (View).
3. **Room context** *(right group, pushed by a flex spacer)*. A **breadcrumb lockup**:
   - `Rooms` — a router `<Link to="/">` (`text-muted-foreground` → `text-foreground`
     on hover), optionally preceded by a decorative `aria-hidden` `ChevronLeft`.
   - a faint `/` separator (`text-faint`),
   - the **room name** (`text-foreground`, `font-medium`),
   - a **Game chip** rendered only when a game is linked: a neutral pill
     (`bg-raised`, `border border-border`, `rounded-full`, `text-[11px]`
     `text-muted-foreground`) with a `Gamepad2` icon + "Game". Neutral, not accent.
   - Then a vertical hairline divider.
4. **Status & identity.** `ModeBadge` (unchanged `StatusPill`), then the user lockup:
   an 18px avatar disk (initial, `bg-raised-hover`, hairline), the username
   (`text-muted-foreground`), and a **ghost switch icon-button** (`Button`
   `variant="ghost" size="icon"`, `LogOut` glyph, `aria-label="Switch user"`,
   `title="Switch user"`).

**Dividers** are 1px-wide, ~18px-tall elements using the hairline token
(`bg-hairline`). A small reusable `ToolbarDivider` keeps them consistent.

### Menu dropdown (de-boxed open state)

The `Menubar` Root loses its box: drop `rounded-md border border-border bg-background
p-1` and the `h-10`; it becomes a plain inline flex container that aligns to the bar.
`MenubarContent` stays a floating **surface** popover — `bg-popover` (= `--surface`),
`border border-border` (hairline), soft shadow, `rounded-[9px]` — with:

- rows that hover/focus to `bg-raised-hover` (retoken `MenubarItem`/`MenubarTrigger`
  away from `focus:bg-accent text-accent-foreground`, since `--color-accent` is
  neutral `raised-hover` anyway — make the intent explicit and avoid any accent-named
  classes on these),
- an uppercase `text-muted-foreground` group label ("Presets") above the preset list
  (decorative; via a small label element, not a new testid),
- optional leading icons on items (`Save` on "Save arrangement…", `RotateCcw` on
  "Reset layout"). Icons are decorative; **item text and testids are unchanged.**

No accent anywhere in the menus.

## Architecture

### Component map

| File | Change |
| --- | --- |
| `app/BrandMark.tsx` *(new)* | Presentational: the monogram tile + wordmark `<h1>`. |
| `app/RoomContext.tsx` *(new)* | Presentational breadcrumb: `Rooms` link + `/` + name + optional `GameChip`. Props: `{ roomName: string; gameLinked: boolean }`. |
| `app/ToolbarDivider.tsx` *(new, tiny)* | 1px hairline vertical rule. |
| `app/Workbench.tsx` | Rezoned toolbar: `h-10`; left group = `BrandMark` + divider + `AppMenubar`; right group = `roomContext` slot + divider + `ModeBadge` + `SwitchUser`. Rename the `leading` prop → `roomContext` (optional `ReactNode`). |
| `app/Menubar.tsx` | Add leading icons to triggers; add the "Presets" group label; de-box (via the primitive). Room context is **not** here. All testids unchanged. |
| `components/ui/menubar.tsx` | De-box `Menubar` Root; retoken `MenubarTrigger`/`MenubarItem` hover/open to `bg-raised-hover`/`text-foreground` (no accent-named classes); keep `MenubarContent` surface popover (confirm `rounded-[9px]`). |
| `app/SwitchUser.tsx` | Rebuild on `Button` (`ghost`/`icon`, `LogOut`, `aria-label="Switch user"`) + avatar + username. No raw `<button>`/`<span>` styling. |
| `app/routes/RoomRoute.tsx` | Store the resolved `room` in state; build `<RoomContext roomName={room.name} gameLinked={!!room.gameId} />` and pass it to `Workbench` via the renamed `roomContext` prop. (Keeps the `Rooms` link inside that node — satisfies the back-link tests.) |
| `app/ModeBadge.tsx` | No logic change; verify it sits correctly in the new right group. |

**Why no `activeRoom.ts` change:** `RoomRoute` already fetches the room and has
`room.name` / `room.gameId` in scope. Building the lockup there and passing it through
the existing `Workbench` chrome prop is the smallest change that satisfies the
`RoomRoute.spec` contract (the back-to-rooms link must flow through the `Workbench`
prop — its test mock renders only that slot). Threading through the context provider
would touch `activeRoom.ts` + its spec for no benefit.

### Data flow

`RoomRoute` (already validates the room) → keeps `room` in state →
`<RoomContext roomName gameLinked />` → passed as `Workbench`'s `roomContext` node →
rendered in the toolbar's right group. Read-only; no new fetches, no behavior change.

## Design-Language Compliance

- **4 surfaces:** canvas (bar), raised (avatar/chip/divider-on…), raised-hover
  (hover/open), surface (popover). No 5th grey.
- **2 hairlines:** dividers + chip + popover border = `--hairline`; ghost button +
  avatar edge = `--hairline-strong`.
- **1 rationed accent:** the brand monogram tile is the sole accent fill. Menus,
  chips, breadcrumb, mode pill, and user control are all neutral. (Mode pill amber is
  the existing `warning` status tone, not accent.)
- **3 text tiers:** wordmark/room-name/active = `text-foreground`; labels, username,
  idle triggers, "Rooms" = `text-muted-foreground`; `/` separator, placeholders =
  `text-faint`.
- **No raw colors:** every color is a token utility (`bg-primary`,
  `text-primary-foreground`, `bg-hairline`, `bg-raised`, `bg-raised-hover`,
  `text-muted-foreground`, `text-faint`, `border-border`, `border-border-strong`).
  Guard test stays green.

## Test Contract (must remain green)

Unit (vitest) and e2e (Playwright) invariants this change must not break:

- **`smoke.spec.ts`:** `getByRole('heading', { name: 'Bloom Studio' })` → keep the
  wordmark as an `<h1>` with text "Bloom Studio". The monogram glyph is decorative
  (`aria-hidden`), not part of the heading text.
- **`SwitchUser.spec.tsx`:** username visible (`getByText(/ada/)`) **and**
  `getByRole('button', { name: /switch user/i })` → the ghost icon-button needs
  `aria-label="Switch user"`.
- **`RoomRoute.spec.tsx`:** `findByRole('link', { name: /rooms/i })` with `href="/"`,
  delivered through the `Workbench` chrome prop → the `Rooms` link lives in
  `RoomContext`, passed via the renamed prop. **Update this spec's `Workbench` mock**
  to render `roomContext` instead of `leading`.
- **`routing.spec.ts` (e2e):** `getByRole('link', { name: /rooms/i }).click()` returns
  to the picker → same `Rooms` link.
- **`Menubar.spec.tsx` + e2e (`chrome`, `styling`, `panes`, `layout-presets`,
  `errors`):** testids `menu-layout`, `menu-view`, `layout-save`,
  `layout-apply-*`, `layout-delete-*`, `menu-reset-layout`, `view-open-*` unchanged;
  no `menu-file`. Icons/labels are additive only.
- **`workbench` testid** on the root container is unchanged.

New tests to add (TDD):

- `BrandMark.spec.tsx` — renders the `Bloom Studio` `<h1>`; monogram is `aria-hidden`.
- `RoomContext.spec.tsx` — renders the `Rooms` link (`href="/"`); shows the room name;
  renders the Game chip iff `gameLinked`; hides it otherwise.
- `SwitchUser.spec.tsx` — extend: assert the switch control is a `Button` (token
  classes present) while preserving the existing role/name + logout assertions.

## Implementation Order (TDD, subagent-driven)

1. **Primitives de-box** — retoken `components/ui/menubar.tsx` (Root de-box, trigger/
   item hover→`raised-hover`, content `rounded-[9px]`). No app-visible testid change.
2. **`BrandMark`** + **`ToolbarDivider`** (new, with `BrandMark.spec`).
3. **`RoomContext`** (new, with `RoomContext.spec`) — breadcrumb + `GameChip`.
4. **`SwitchUser`** rebuilt on `Button` (extend spec).
5. **`Menubar.tsx`** — add icons + "Presets" label.
6. **`RoomRoute.tsx`** — keep `room` in state; render+pass `RoomContext` via
   `roomContext`; update `RoomRoute.spec` mock.
7. **`Workbench.tsx`** — rezone the bar to `h-10`, wire the four zones + dividers;
   rename `leading`→`roomContext`.
8. **Whole-branch review** + visual check.

## Validation

- `prettier --check .`, `nx typecheck`, unit tests, build (the four Frontend CI gates).
- The no-raw-color guard (`design-language.guard.spec.ts`) returns zero hits.
- **`just e2e` against a replay backend before the PR** — perform the delicate
  `:8000` live→replay swap and restore it afterward; CI pins Node 20. The
  `theme.spec.ts` reference screenshot will re-shoot; review the toolbar diff in the
  PR.

## Branch & PR

- Branch `feat/studio-toolbar` off `main` (assume PR #41 merged). `main` is protected
  — land via squash PR, self-merge OK once checks pass.

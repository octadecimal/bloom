# NavRail hover-expand design

**Date:** 2026-07-14
**Status:** Approved
**Scope:** `studio/frontend/src/app/NavRail.tsx` (workbench UX pass 4)

## Problem

The nav rail (merged #209/#210) expands only via the pin toggle. The user wants it
to expand on rollover and collapse when the pointer/focus leaves, without losing
the pin.

## Design

Hover-expand layers on top of the existing pin; both feed one effective flag.

- Keep the persisted pin state (`bloom.navRailExpanded` localStorage key,
  unchanged); rename the state variable `expanded` → `pinned` for clarity.
- Add transient `hovered` state. Effective expansion `expanded = pinned || hovered`
  drives everything that `expanded` drives today (width, labels, group headers,
  `aria-expanded`). The rail already expands as an overlay above the dock, so
  hover-expansion causes no reflow.
- **Hover intent:** `onMouseEnter` starts a ~150 ms timer before setting
  `hovered`; `onMouseLeave` cancels the timer and clears `hovered` immediately.
  Skating the cursor across the rail never flashes the flyout; collapse is snappy.
- **Keyboard parity:** `onFocusCapture` on the nav sets `hovered` (no delay);
  `onBlurCapture` clears it when focus leaves the rail (check
  `relatedTarget`/`contains`). Tabbing into the rail expands it; tabbing out
  collapses it.
- **Pin wins:** while `pinned`, leave/blur do nothing visible (hovered may clear,
  but `pinned` keeps it open). The toggle button is unchanged: clicking while
  hover-expanded pins it open; clicking while pinned unpins (rail then collapses
  on leave as usual).

No new components, dependencies, or CSS; the diff is confined to `NavRail.tsx`
plus tests.

## Testing

- **Unit (`NavRail.spec.tsx`):** hover → expands after delay; leave → collapses;
  leave while pinned → stays expanded; focus/blur mirror hover/leave; toggle
  still persists to localStorage.
- **E2e (`e2e/nav-rail.spec.ts`):** hover the rail → labels visible; move
  pointer to the dock → rail back to icon-only; pin while hovered → survives
  pointer leaving.

## Out of scope

- Auto-unpin timers or hover-disable settings (YAGNI).
- Any content reflow behavior — the overlay model from #210 is kept as-is.

# NavRail Hover-Expand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The nav rail expands on hover (after a 150 ms intent delay) and collapses when the pointer/focus leaves, while the existing pin toggle still forces it open.

**Architecture:** Layer a transient `hovered` state over the persisted pin inside `NavRail.tsx`; effective expansion is `pinned || hovered` and drives everything the old `expanded` flag drove (width, labels, `aria-expanded`). The rail already renders as an overlay above the dock (#210), so hovering never reflows the layout. No new components, files, or dependencies.

**Tech Stack:** React 18 + Tailwind (studio/frontend), Vitest + Testing Library (unit), Playwright (e2e, replay backend).

**Spec:** `docs/superpowers/specs/2026-07-14-navrail-hover-expand-design.md`

## Global Constraints

- Work in worktree `C:\code\bloom.wt\navrail-hover`, branch `feat/navrail-hover`, `BLOOM_PORT_OFFSET=1` (backend :8001, frontend :4201 — never the default ports; another session may hold them).
- Semantic commit format (`feat(studio): ...`, `test(studio): ...`).
- localStorage key stays `bloom.navRailExpanded` (pin only — hover must never write it).
- Hover-intent delay: 150 ms on enter; collapse on leave is immediate. Keyboard focus expands with no delay.
- Pin wins: while pinned, leave/blur never collapse the rail.
- Playwright e2e is the behavioral contract; run locally against a replay backend, never CI.
- Frontend gates before pushing: `node_modules/.bin/prettier --check .`, `npx nx typecheck frontend`, `npx nx test frontend`, `npx nx build frontend` (vitest green does not imply types valid).
- `just` recipes may fail in PowerShell ("could not find the shell sh") — run `just` commands from the Bash tool (Git Bash), or use the expanded commands given in the steps.

---

### Task 0: Bootstrap the worktree

Fresh worktrees have no `node_modules` / venv.

- [ ] **Step 1: Install deps**

Run from `C:\code\bloom.wt\navrail-hover`:

```
npm install
cd studio\backend; uv sync
```

Expected: both complete without error. No commit (nothing tracked changes).

---

### Task 1: Hover/focus expansion in NavRail (unit-level TDD)

**Files:**

- Modify: `studio/frontend/src/app/NavRail.tsx` (component body ~lines 99–124)
- Test: `studio/frontend/src/app/NavRail.spec.tsx` (append a describe block)

**Interfaces:**

- Consumes: existing `NavRail` internals — `EXPAND_KEY = 'bloom.navRailExpanded'`, `expanded` state, `data-testid="nav-rail"` / `"rail-toggle"`.
- Produces: `<nav data-testid="nav-rail">` gains `onMouseEnter`/`onMouseLeave`/`onFocus`/`onBlur` behavior; internal state renamed `expanded` → `pinned` plus new `hovered`; rendered class switches `w-10` ↔ `w-44` on `pinned || hovered`. `aria-expanded` on `rail-toggle` reflects the effective (combined) expansion. Task 2's e2e relies on exactly this.

- [ ] **Step 1: Write the failing tests**

Append to `studio/frontend/src/app/NavRail.spec.tsx` (note: `fireEvent.mouseOver`/`mouseOut`, not `mouseEnter`/`mouseLeave` — React synthesizes enter/leave from over/out, so the latter never reach React handlers in jsdom):

```tsx
describe('NavRail hover expand', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('expands after the hover-intent delay and collapses immediately on leave', () => {
    render(<NavRail />);
    const nav = screen.getByTestId('nav-rail');
    fireEvent.mouseOver(nav);
    expect(nav.className).toContain('w-10'); // intent delay not elapsed yet
    act(() => vi.advanceTimersByTime(150));
    expect(nav.className).toContain('w-44');
    expect(screen.getByTestId('rail-toggle')).toHaveAttribute('aria-expanded', 'true');
    fireEvent.mouseOut(nav);
    expect(nav.className).toContain('w-10');
  });

  it('never expands when the cursor skates through within the delay', () => {
    render(<NavRail />);
    const nav = screen.getByTestId('nav-rail');
    fireEvent.mouseOver(nav);
    fireEvent.mouseOut(nav);
    act(() => vi.advanceTimersByTime(1000));
    expect(nav.className).toContain('w-10');
  });

  it('hover never writes the pin key; pinning while hovered survives leave', () => {
    render(<NavRail />);
    const nav = screen.getByTestId('nav-rail');
    fireEvent.mouseOver(nav);
    act(() => vi.advanceTimersByTime(150));
    expect(localStorage.getItem('bloom.navRailExpanded')).toBeNull();
    fireEvent.click(screen.getByTestId('rail-toggle')); // pin while hover-expanded
    expect(localStorage.getItem('bloom.navRailExpanded')).toBe('1');
    fireEvent.mouseOut(nav); // pin wins
    expect(nav.className).toContain('w-44');
  });

  it('expands on focus with no delay and collapses when focus leaves the rail', () => {
    render(<NavRail />);
    const nav = screen.getByTestId('nav-rail');
    const btn = screen.getByTestId('rail-open-llm-chat/room');
    fireEvent.focus(btn);
    expect(nav.className).toContain('w-44');
    fireEvent.blur(btn, { relatedTarget: document.body });
    expect(nav.className).toContain('w-10');
  });

  it('stays expanded while focus moves between rail buttons', () => {
    render(<NavRail />);
    fireEvent.focus(screen.getByTestId('rail-open-llm-chat/room'));
    fireEvent.blur(screen.getByTestId('rail-open-llm-chat/room'), {
      relatedTarget: screen.getByTestId('rail-open-gdd/viewer'),
    });
    expect(screen.getByTestId('nav-rail').className).toContain('w-44');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run from the worktree root: `npx nx test frontend`
Expected: the 5 new tests FAIL (rail stays `w-10`); all pre-existing tests still PASS.

- [ ] **Step 3: Implement**

In `studio/frontend/src/app/NavRail.tsx`:

Add `useRef` to the react import (line 1):

```tsx
import { useEffect, useRef, useState, type ComponentType } from 'react';
```

Below `const EXPAND_KEY = ...` (line 49) add:

```tsx
const HOVER_DELAY_MS = 150; // hover intent: skating across the rail must not flash the flyout
```

Inside `NavRail()`, replace the `expanded` state + `toggle` (lines 111–117) with:

```tsx
const [pinned, setPinned] = useState(() => localStorage.getItem(EXPAND_KEY) === '1');
const [hovered, setHovered] = useState(false);
const hoverTimer = useRef<number | undefined>(undefined);
useEffect(() => () => window.clearTimeout(hoverTimer.current), []);
const expanded = pinned || hovered;
const toggle = () => {
  const next = !pinned;
  if (next) localStorage.setItem(EXPAND_KEY, '1');
  else localStorage.removeItem(EXPAND_KEY);
  setPinned(next);
};
const hoverEnter = () => {
  window.clearTimeout(hoverTimer.current);
  hoverTimer.current = window.setTimeout(() => setHovered(true), HOVER_DELAY_MS);
};
const hoverLeave = () => {
  window.clearTimeout(hoverTimer.current);
  setHovered(false);
};
```

On the `<nav>` element (line 122), add the handlers (keyboard focus expands with no delay; blur only collapses when focus exits the rail):

```tsx
<nav
  data-testid="nav-rail"
  onMouseEnter={hoverEnter}
  onMouseLeave={hoverLeave}
  onFocus={() => {
    window.clearTimeout(hoverTimer.current);
    setHovered(true);
  }}
  onBlur={(e) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hoverLeave();
  }}
  className={/* unchanged */}
>
```

Everything else (`RailButton`, groups, the toggle button JSX) keeps reading `expanded` and is untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx nx test frontend`
Expected: ALL tests PASS, including the pre-existing expand/collapse block (jsdom clicks fire no hover, so `pinned` alone drives those).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/app/NavRail.tsx studio/frontend/src/app/NavRail.spec.tsx
git commit -m "feat(studio): nav rail expands on hover, collapses on leave (pin wins)"
```

---

### Task 2: E2e contract — hover flow + fix now-stale toggle assertions

**Files:**

- Modify: `studio/frontend/e2e/nav-rail.spec.ts`

**Interfaces:**

- Consumes: Task 1's behavior — hovering `nav-rail` expands after 150 ms; unpinning while the mouse is still over the rail keeps it hover-expanded until the pointer leaves; `aria-expanded` reflects `pinned || hovered`.
- Produces: the authoritative Playwright contract for hover-expand.

**Background — why two existing tests must change:** they click `rail-toggle` to collapse and immediately assert `aria-expanded=false`. With hover-expand, the mouse is still over the toggle after the click, so the rail correctly stays open (hovered) until the pointer leaves. The tests must move the mouse off the rail before asserting collapse. This is a deliberate contract change, not a regression.

- [ ] **Step 1: Update the two stale tests**

In `studio/frontend/e2e/nav-rail.spec.ts`, replace the test `'expanding the rail overlays the dock without resizing it'` with:

```ts
test('expanding the rail overlays the dock without resizing it', async ({ page }) => {
  await gotoWorkbench(page);
  const dock = page.getByTestId('dock-area');
  const before = await dock.boundingBox();
  expect(before).not.toBeNull();

  await page.getByTestId('rail-toggle').click();
  await expect(page.getByTestId('nav-rail')).toContainText('Design');
  // The dock never moves or resizes — the rail expands as an overlay.
  expect(await dock.boundingBox()).toEqual(before);

  await page.getByTestId('rail-toggle').click(); // unpin; still hover-expanded until the pointer leaves
  await page.mouse.move(640, 400); // leave the rail
  await expect(page.getByTestId('rail-toggle')).toHaveAttribute('aria-expanded', 'false');
  expect(await dock.boundingBox()).toEqual(before);
});
```

and replace `'rail expands with labels, persists across reload, collapses back'` with:

```ts
test('rail expands with labels, persists across reload, collapses back', async ({ page }) => {
  await gotoWorkbench(page);
  const toggle = page.getByTestId('rail-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('rail-open-math/viewer')).not.toContainText('Math');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('rail-open-math/viewer')).toContainText('Math');
  await expect(page.getByTestId('nav-rail')).toContainText('Design');
  await expect(page.getByTestId('nav-rail')).toContainText('Art');

  await page.reload();
  await expect(page.getByTestId('workbench')).toBeVisible();
  await expect(page.getByTestId('rail-toggle')).toHaveAttribute('aria-expanded', 'true');

  await page.getByTestId('rail-toggle').click(); // unpin; still hover-expanded
  await page.mouse.move(640, 400); // leave the rail
  await expect(page.getByTestId('rail-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('rail-open-math/viewer')).not.toContainText('Math');
});
```

- [ ] **Step 2: Add the hover-flow tests**

Append to the same file:

```ts
test('rail expands on hover and collapses when the pointer leaves', async ({ page }) => {
  await gotoWorkbench(page);
  await expect(page.getByTestId('rail-open-math/viewer')).not.toContainText('Math');

  await page.getByTestId('nav-rail').hover();
  await expect(page.getByTestId('rail-open-math/viewer')).toContainText('Math');
  // transient peek — the pin key is never written by hover
  expect(await page.evaluate(() => localStorage.getItem('bloom.navRailExpanded'))).toBeNull();

  await page.mouse.move(640, 400);
  await expect(page.getByTestId('rail-open-math/viewer')).not.toContainText('Math');
});

test('pinning while hover-expanded survives the pointer leaving', async ({ page }) => {
  await gotoWorkbench(page);
  await page.getByTestId('nav-rail').hover();
  await page.getByTestId('rail-toggle').click();
  await page.mouse.move(640, 400);
  await expect(page.getByTestId('rail-open-math/viewer')).toContainText('Math');
  await expect(page.getByTestId('rail-toggle')).toHaveAttribute('aria-expanded', 'true');
});
```

- [ ] **Step 3: Run the e2e spec against a replay backend**

From the Bash tool (Git Bash — `just` needs `sh`), in `/c/code/bloom.wt/navrail-hover`:

1. Start the replay backend in the background: `just backend-serve-replay` (worktree `.env` has `BLOOM_PORT_OFFSET=1` → backend :8001; export `BLOOM_PORT_OFFSET=1` in the shell first if `.env` isn't auto-loaded — Playwright must NOT silently attach to a default-port stack).
2. Run: `BLOOM_PORT_OFFSET=1 npx playwright test --config=studio/frontend/playwright.config.ts e2e/nav-rail.spec.ts`

Expected: all nav-rail tests PASS (6 tests).

- [ ] **Step 4: Run the full e2e suite**

Run: `BLOOM_PORT_OFFSET=1 npx playwright test --config=studio/frontend/playwright.config.ts`
Expected: suite green (known baseline: 3 port-hardcoded game-plugin unit tests fail only under `nx run-many` in offset worktrees — not Playwright; full e2e needs the engine dev server which the harness boots on :9301).

- [ ] **Step 5: Frontend gates**

Run from the worktree root (PowerShell fine):

```
node_modules\.bin\prettier --check .
npx nx typecheck frontend
npx nx test frontend
npx nx build frontend
```

Expected: all four exit 0.

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/e2e/nav-rail.spec.ts
git commit -m "test(studio): e2e contract for nav rail hover-expand"
```

---

### Task 3: Push + PR

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin feat/navrail-hover
gh pr create --title "feat(studio): nav rail hover-expand (workbench UX pass 4)" --body "$(cat <<'EOF'
Rail expands on rollover (150ms hover intent), collapses on pointer/focus leave; the pin toggle still forces it open and wins over hover-out. Spec: docs/superpowers/specs/2026-07-14-navrail-hover-expand-design.md

- expanded = pinned || hovered; overlay model from #210 unchanged (no reflow)
- keyboard parity: focus-in expands (no delay), focus-out collapses
- e2e: 2 stale toggle assertions updated (mouse must leave before collapse asserts), 2 hover-flow tests added

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR opens against `main`. CI runs prettier/typecheck/test/build (no browser e2e in CI — already run locally in Task 2).

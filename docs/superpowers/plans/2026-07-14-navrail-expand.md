# Expandable Nav Rail (Workbench UX Pass 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The NavRail expands to icon + text labels (with journey-group headers) and collapses back to icon-only, persisting the choice in localStorage.

**Architecture:** All changes live in `studio/frontend/src/app/NavRail.tsx` — one `expanded` boolean (lazy-initialized from localStorage key `bloom.navRailExpanded`), a bottom-pinned toggle button, and conditional label rendering. The rail stays in normal flex flow; Dockview handles the resize. Default is collapsed, so fresh sessions and the e2e suite are pixel-identical to the shipped rail (no widening of issue #207's blast radius).

**Tech Stack:** React 18 + Tailwind (token classes only — no raw colors, guard-tested), lucide-react icons, Vitest + Testing Library (unit), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-07-14-workbench-navrail-expand-design.md`

## Global Constraints

- Worktree: `C:\code\bloom.wt\navrail-expand`, branch `feat/navrail-expand`, `BLOOM_PORT_OFFSET=1` → backend :8001, frontend :4201, runtime :4301, e2e game server :9301. NEVER use the default :8000/:4200 ports — another session may hold them.
- localStorage key: `bloom.navRailExpanded`, value `'1'` when expanded, key removed when collapsed. Default (absent) = collapsed.
- Widths: collapsed `w-10` (40px, unchanged), expanded `w-44` (176px). Transition `transition-[width] duration-150`.
- Design language: only existing token classes (`text-foreground`, `text-muted-foreground`, `bg-selection`, `bg-raised-hover`, `border-border`, `bg-canvas`). No `styles.css` changes. The no-raw-color guard (`design-language.guard.spec.ts`) must stay green.
- Semantic commits (`feat(studio): …`, `test(studio): …`).
- `just` recipes need `sh` on PATH — run them from Git Bash (the Bash tool), not PowerShell.
- All commands below run from the worktree root unless stated otherwise.

---

### Task 1: Expanded state, toggle button, persistence, width

**Files:**

- Modify: `studio/frontend/src/app/NavRail.tsx`
- Test: `studio/frontend/src/app/NavRail.spec.tsx`

**Interfaces:**

- Consumes: existing `NavRail` internals (shipped in PR #208).
- Produces: `expanded: boolean` state inside `NavRail`, a `data-testid="rail-toggle"` button with `aria-expanded`, nav width classes `w-10`/`w-44`, localStorage persistence under `bloom.navRailExpanded`. Task 2 threads `expanded` into `RailButton` and group rendering.

- [ ] **Step 1: Write the failing tests**

In `studio/frontend/src/app/NavRail.spec.tsx`, add `localStorage.clear()` to the existing `beforeEach`:

```tsx
beforeEach(() => {
  openPane.mockClear();
  _resetDockviewApiForTests();
  localStorage.clear();
  setHost(fakeHost(PANES));
});
```

Then add a new describe block after the existing `describe('NavRail', …)` block:

```tsx
describe('NavRail expand/collapse', () => {
  it('starts collapsed by default with an expand toggle', () => {
    render(<NavRail />);
    expect(screen.getByTestId('nav-rail').className).toContain('w-10');
    const toggle = screen.getByTestId('rail-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('title', 'Expand navigation');
  });

  it('toggle expands the rail and persists the choice', () => {
    render(<NavRail />);
    fireEvent.click(screen.getByTestId('rail-toggle'));
    expect(screen.getByTestId('nav-rail').className).toContain('w-44');
    expect(screen.getByTestId('rail-toggle')).toHaveAttribute('aria-expanded', 'true');
    expect(localStorage.getItem('bloom.navRailExpanded')).toBe('1');
  });

  it('mounts expanded when persisted; collapsing clears the key', () => {
    localStorage.setItem('bloom.navRailExpanded', '1');
    render(<NavRail />);
    expect(screen.getByTestId('nav-rail').className).toContain('w-44');
    fireEvent.click(screen.getByTestId('rail-toggle'));
    expect(screen.getByTestId('nav-rail').className).toContain('w-10');
    expect(localStorage.getItem('bloom.navRailExpanded')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd studio/frontend && npx vitest run src/app/NavRail.spec.tsx
```

Expected: the 3 new tests FAIL with "Unable to find an element by: [data-testid="rail-toggle"]"; the 4 existing tests still PASS.

- [ ] **Step 3: Implement state, toggle, and width**

In `studio/frontend/src/app/NavRail.tsx`:

1. Extend the lucide import with the toggle icons:

```tsx
import {
  MessageSquare,
  FileText,
  Gamepad2,
  SlidersHorizontal,
  Images,
  ListTree,
  LayoutTemplate,
  Settings2,
  Network,
  Sigma,
  Settings,
  SquarePen,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
```

2. Add the storage key constant next to `UTILITY_IDS`:

```tsx
const EXPAND_KEY = 'bloom.navRailExpanded';
```

3. In the `NavRail` component body, add state + toggle handler (before the `return`):

```tsx
const [expanded, setExpanded] = useState(() => localStorage.getItem(EXPAND_KEY) === '1');
const toggle = () => {
  const next = !expanded;
  if (next) localStorage.setItem(EXPAND_KEY, '1');
  else localStorage.removeItem(EXPAND_KEY);
  setExpanded(next);
};
```

4. Replace the `<nav>` opening tag's className so the width is stateful and clips cleanly mid-transition:

```tsx
<nav
  data-testid="nav-rail"
  className={`flex flex-shrink-0 flex-col items-center gap-1 overflow-hidden border-r border-border bg-canvas py-2 transition-[width] duration-150 ${expanded ? 'w-44' : 'w-10'}`}
>
```

5. Add the toggle block as the LAST child of the nav, after the utility group's closing `</div>`:

```tsx
<div className={`mt-1 flex w-full flex-col border-t border-border pt-2 ${expanded ? 'px-1' : 'items-center'}`}>
  <button
    type="button"
    data-testid="rail-toggle"
    aria-expanded={expanded}
    title={expanded ? 'Collapse navigation' : 'Expand navigation'}
    aria-label={expanded ? 'Collapse navigation' : 'Expand navigation'}
    onClick={toggle}
    className={`flex h-8 items-center rounded-md text-muted-foreground transition-colors hover:bg-raised-hover hover:text-foreground ${expanded ? 'w-full' : 'w-8 justify-center'}`}
  >
    <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center">
      {expanded ? <PanelLeftClose aria-hidden className="h-4 w-4" /> : <PanelLeftOpen aria-hidden className="h-4 w-4" />}
    </span>
    {expanded && <span className="whitespace-nowrap text-xs">Collapse</span>}
  </button>
</div>
```

Do NOT touch `RailButton` or the group rendering in this task — labels are Task 2.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd studio/frontend && npx vitest run src/app/NavRail.spec.tsx
```

Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/app/NavRail.tsx studio/frontend/src/app/NavRail.spec.tsx
git commit -m "feat(studio): nav rail expand/collapse toggle with localStorage persistence"
```

---

### Task 2: Pane labels and group headers when expanded

**Files:**

- Modify: `studio/frontend/src/app/NavRail.tsx`
- Test: `studio/frontend/src/app/NavRail.spec.tsx`

**Interfaces:**

- Consumes: `expanded` state and `rail-toggle` from Task 1.
- Produces: `RailButton({ pane, expanded })` signature; expanded rows render the pane title in `text-xs`; expanded curated groups render `Design` / `Art` / `Math` headers (uppercased by CSS — text content stays mixed-case) instead of hairline dividers; the uncurated overflow group keeps a divider in both states; native `title` tooltip only when collapsed.

- [ ] **Step 1: Write the failing tests**

Add to the `describe('NavRail expand/collapse', …)` block in `studio/frontend/src/app/NavRail.spec.tsx`:

```tsx
it('shows pane labels and group headers only when expanded', () => {
  render(<NavRail />);
  expect(screen.queryByText('Design')).toBeNull();
  expect(screen.getByTestId('rail-open-math/viewer')).not.toHaveTextContent('Math');
  fireEvent.click(screen.getByTestId('rail-toggle'));
  expect(screen.getByText('Design')).toBeInTheDocument();
  expect(screen.getByText('Art')).toBeInTheDocument();
  expect(screen.getByTestId('rail-open-math/viewer')).toHaveTextContent('Math');
  expect(screen.getByTestId('rail-open-llm-chat/room')).toHaveTextContent('Chat Room');
});

it('drops the native tooltip when expanded (label is visible)', () => {
  render(<NavRail />);
  expect(screen.getByTestId('rail-open-math/viewer')).toHaveAttribute('title', 'Math');
  fireEvent.click(screen.getByTestId('rail-toggle'));
  expect(screen.getByTestId('rail-open-math/viewer')).not.toHaveAttribute('title');
});

it('gives the uncurated overflow group no header when expanded', () => {
  setHost(fakeHost([...PANES, { id: 'mystery/pane', title: 'Zephyr' }]));
  render(<NavRail />);
  fireEvent.click(screen.getByTestId('rail-toggle'));
  expect(screen.getByTestId('rail-open-mystery/pane')).toHaveTextContent('Zephyr');
  expect(screen.queryByText('Other')).toBeNull();
});
```

Assertion-design note: the `Math` group header and the `Math` pane title are both real text, so `getByText('Math')` would be ambiguous (2 matches). Assert group headers via the unambiguous `Design`/`Art` texts, and pane labels via `toHaveTextContent` on the button testid. (Headers render mixed-case text uppercased by CSS — match `'Design'`, not `'DESIGN'`.)

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd studio/frontend && npx vitest run src/app/NavRail.spec.tsx
```

Expected: the 3 new tests FAIL (no labels render; tooltip still present when expanded). The 7 existing tests PASS.

- [ ] **Step 3: Implement labels and group headers**

In `studio/frontend/src/app/NavRail.tsx`:

1. Replace the `GROUP_ORDER` constant with a labeled structure (same ids, same order):

```tsx
const GROUPS: Array<{ label: string; ids: string[] }> = [
  { label: 'Design', ids: ['llm-chat/room', 'gdd/viewer'] },
  {
    label: 'Art',
    ids: ['game/preview', 'property-inspector/panel', 'assets/board', 'scene-graph/tree', 'region-overrides/preview'],
  },
  { label: 'Math', ids: ['game-config/editor', 'game-structure/editor', 'math/viewer'] },
];
```

2. Replace `RailButton` with the expanded-aware version (icon in a fixed `w-8` slot so its centerline never moves between states; tooltip collapsed-only):

```tsx
function RailButton({ pane, expanded }: { pane: IPaneDef; expanded: boolean }) {
  const host = getHost();
  const api = getDockviewApi();
  const open = !!api?.getPanel(pane.id);
  const active = api?.activePanel?.id === pane.id;
  const Icon = ICONS[pane.id];
  const tier = active ? 'bg-selection text-foreground' : open ? 'text-foreground' : 'text-muted-foreground';
  return (
    <button
      type="button"
      data-testid={`rail-open-${pane.id}`}
      title={expanded ? undefined : pane.title}
      aria-label={pane.title}
      onClick={() => host.openPane(pane.id)}
      className={`flex h-8 items-center rounded-md transition-colors hover:bg-raised-hover hover:text-foreground ${expanded ? 'w-full' : 'w-8 justify-center'} ${tier}`}
    >
      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center">
        {Icon ? <Icon aria-hidden className="h-4 w-4" /> : <span className="text-xs">{pane.title.charAt(0).toUpperCase()}</span>}
      </span>
      {expanded && <span className="whitespace-nowrap text-xs">{pane.title}</span>}
    </button>
  );
}
```

3. In the `NavRail` body, replace the group assembly (the `curated` / `groups` / `rest` lines) with:

```tsx
const curated = new Set([...GROUPS.flatMap((g) => g.ids), ...UTILITY_IDS]);
const groups = GROUPS.map((g) => ({
  label: g.label,
  panes: g.ids.filter((id) => panes.has(id)).map((id) => panes.get(id)!),
})).filter((g) => g.panes.length > 0);
const rest = [...panes.values()].filter((p) => !curated.has(p.id));
if (rest.length > 0) groups.push({ label: '', panes: rest });
```

4. Replace the group rendering inside the nav (expanded labeled groups swap the hairline divider for an uppercase `--text-2` header; the label-less overflow group keeps its divider in both states):

```tsx
{
  groups.map((group, gi) => (
    <div
      key={gi}
      className={`flex flex-col gap-1 ${expanded ? 'w-full px-1' : 'w-8 items-center'} ${
        gi > 0 && (!expanded || !group.label) ? 'mt-1 border-t border-border pt-2' : ''
      }`}
    >
      {expanded && group.label && <div className="px-2 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{group.label}</div>}
      {group.panes.map((p) => (
        <RailButton key={p.id} pane={p} expanded={expanded} />
      ))}
    </div>
  ));
}
```

5. Update the utility group wrapper and pass `expanded` to its buttons:

```tsx
<div className={`flex flex-col gap-1 ${expanded ? 'w-full px-1' : 'w-8 items-center'}`}>
  {utility.map((p) => (
    <RailButton key={p.id} pane={p} expanded={expanded} />
  ))}
</div>
```

- [ ] **Step 4: Run the full frontend unit suite**

```bash
cd studio/frontend && npx vitest run
```

Expected: all PASS — including `design-language.guard.spec.ts` (only token classes were used) and the 10 NavRail tests.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/app/NavRail.tsx studio/frontend/src/app/NavRail.spec.tsx
git commit -m "feat(studio): pane labels + journey group headers on expanded nav rail"
```

---

### Task 3: E2e coverage, frontend gates, full suite

**Files:**

- Modify: `studio/frontend/e2e/nav-rail.spec.ts`

**Interfaces:**

- Consumes: `rail-toggle` testid + `aria-expanded` (Task 1), pane labels (Task 2), existing `gotoWorkbench` helper (`studio/frontend/e2e/helpers.ts` — hermetic, stubs `/rooms`).
- Produces: nothing downstream — this is the verification gate before PR.

- [ ] **Step 1: Write the e2e test**

Append to `studio/frontend/e2e/nav-rail.spec.ts`:

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

  await page.getByTestId('rail-toggle').click();
  await expect(page.getByTestId('rail-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('rail-open-math/viewer')).not.toContainText('Math');
});
```

(`page.route` stubs and localStorage survive `page.reload()` — same browser context.)

- [ ] **Step 2: Start the replay backend (worktree ports) and run the nav-rail spec**

In one Bash shell (background):

```bash
cd /c/code/bloom.wt/navrail-expand && export BLOOM_PORT_OFFSET=1 && just backend-serve-replay
```

Wait for `Uvicorn running on http://127.0.0.1:8001`. Then:

```bash
cd /c/code/bloom.wt/navrail-expand && export BLOOM_PORT_OFFSET=1 && npx playwright test --config=studio/frontend/playwright.config.ts nav-rail
```

Expected: 3 PASS (2 existing + 1 new). **ALWAYS export `BLOOM_PORT_OFFSET=1` first** — without it Playwright's `reuseExistingServer` silently attaches to another session's default-port stack.

- [ ] **Step 3: Run the four frontend CI gates**

```bash
cd /c/code/bloom.wt/navrail-expand && node_modules/.bin/prettier --check . && npx nx typecheck frontend && npx nx test frontend && npx nx build frontend
```

Expected: all four PASS. Use the pinned `node_modules/.bin/prettier` (npx may pull a newer prettier that disagrees on markdown). If prettier flags the new spec/plan markdown files, run `node_modules/.bin/prettier --write` on them and amend/commit.

- [ ] **Step 4: Full e2e suite (replay backend still up)**

```bash
cd /c/code/bloom.wt/navrail-expand && export BLOOM_PORT_OFFSET=1 && just e2e
```

Expected: suite green (the default-collapsed rail is pixel-identical to the shipped one, so width-marginal specs behave exactly as on main; issue #207's known full-suite-load flake may still show — rerun any width-marginal failure once to confirm flake vs regression).

After the run: `git status docs/design-language/reference-workbench.png`. Expected unchanged (collapsed default). If it differs, eyeball the diff — commit the re-shoot only if there is a real, intended visual delta; otherwise `git checkout -- docs/design-language/reference-workbench.png`.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/e2e/nav-rail.spec.ts
git commit -m "test(studio): e2e for nav rail expand/persist/collapse"
```

---

## After the plan

Push and open the PR (default flow, no options menu):

```bash
git push -u origin feat/navrail-expand
gh pr create --title "feat(studio): expandable navigation rail (workbench UX pass 3)" --body "..."
```

Then `/bloom:complete-work` once CI is green.

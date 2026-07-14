# Workbench Navigation Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An always-visible left icon rail in the studio shell that launches/focuses every registered pane and honestly shows open/active state.

**Architecture:** One new `NavRail` component reads `host.listPanes()` and owns a central id → icon/group curation map (spec approach A — `IPaneDef` unchanged). A tiny `dockviewApiRef` state ref (mirroring `hostRef`) gives the rail the DockviewApi for open/active state. A one-line guard in `host.openPane` stops already-active re-activation (the #200 no-op case) for every caller.

**Tech Stack:** React + TypeScript, lucide-react icons, Tailwind utilities bound to the design-language tokens, vitest + @testing-library/react, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-07-14-workbench-navrail-design.md`

## Global Constraints

- Worktree `C:\code\bloom.wt\navrail`, branch `feat/navrail`, `BLOOM_PORT_OFFSET=1` → backend :8001, frontend :4201, runtime :4301. NEVER use the offset-0 ports (another session may hold them).
- Design language (`docs/design-language.md`): no raw colors — only token utilities (`bg-canvas`, `border-border`, `text-foreground`, `text-muted-foreground`, `bg-raised-hover`, `bg-selection`). The guard test `design-language.guard.spec.ts` fails the build on any hex/rgba literal outside `styles.css`.
- TypeScript interfaces use the `I` prefix (`docs/coding-standards.md`).
- Semantic commit messages (Conventional Commits), imperative mood.
- The View menu (`view-open-*` testids), command palette, and PhaseSwitcher are UNTOUCHED — 29 e2e specs depend on the View menu.
- Format any touched markdown with the PINNED prettier (`node_modules/.bin/prettier`), never npx-latest.
- All commands below run from the worktree root `C:\code\bloom.wt\navrail` unless stated otherwise.

---

### Task 1: `host.openPane` already-active guard

**Files:**

- Create: `studio/frontend/src/host/host.spec.ts`
- Modify: `studio/frontend/src/host/host.ts` (the `openPane` branch, lines 27–31)

**Interfaces:**

- Consumes: existing `createHost(deps)` from `./host`, `createPaneRegistry` from `./paneRegistry`, `createCommandRegistry` from `./commandRegistry`.
- Produces: `host.openPane(id)` that (a) no-ops when the panel is already the active Dockview panel, (b) calls `existing.api.setActive()` when open-but-inactive, (c) `api.addPanel(...)` when missing. Task 3's rail relies on exactly these semantics.

- [ ] **Step 1: Write the failing test**

```ts
// studio/frontend/src/host/host.spec.ts
import { describe, it, expect, vi } from 'vitest';
import { createHost } from './host';
import { createPaneRegistry } from './paneRegistry';
import { createCommandRegistry } from './commandRegistry';

function makeHost(api: unknown) {
  return createHost({
    paneRegistry: createPaneRegistry(),
    commandRegistry: createCommandRegistry(),
    getApi: () => api,
    resetLayout: () => undefined,
  });
}

describe('host.openPane', () => {
  it('no-ops when the panel is already active (avoids pointless reattach/iframe reload)', () => {
    const setActive = vi.fn();
    const api = { getPanel: () => ({ api: { isActive: true, setActive } }), addPanel: vi.fn() };
    makeHost(api).openPane('game/preview');
    expect(setActive).not.toHaveBeenCalled();
    expect(api.addPanel).not.toHaveBeenCalled();
  });

  it('focuses an open-but-inactive panel', () => {
    const setActive = vi.fn();
    const api = { getPanel: () => ({ api: { isActive: false, setActive } }), addPanel: vi.fn() };
    makeHost(api).openPane('game/preview');
    expect(setActive).toHaveBeenCalledOnce();
  });

  it('creates a missing panel', () => {
    const api = { getPanel: () => undefined, addPanel: vi.fn() };
    makeHost(api).openPane('game/preview');
    expect(api.addPanel).toHaveBeenCalledWith(expect.objectContaining({ id: 'game/preview', component: 'game/preview' }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/host/host.spec.ts`
Expected: FAIL — "no-ops when the panel is already active" fails (`setActive` WAS called); the other two pass (existing behavior).

- [ ] **Step 3: Write minimal implementation**

In `studio/frontend/src/host/host.ts`, replace the `if (existing)` block inside `openPane`:

```ts
if (existing) {
  // Re-activating an already-active panel reattaches its DOM and reloads the
  // engine iframe (issue #200's no-op case) — skip it.
  if (!existing.api.isActive) existing.api.setActive();
  return;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/host/host.spec.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/host/host.spec.ts studio/frontend/src/host/host.ts
git commit -m "fix(studio): openPane no-ops on already-active panel"
```

---

### Task 2: `dockviewApiRef` state ref, wired in `setupApp`

**Files:**

- Create: `studio/frontend/src/state/dockviewApiRef.ts`
- Create: `studio/frontend/src/state/dockviewApiRef.spec.ts`
- Modify: `studio/frontend/src/app/setupApp.ts` (the `attachDockview` closure, ~line 76)

**Interfaces:**

- Consumes: `DockviewApi` type from `dockview-react`.
- Produces (Task 3 depends on these exact names):
  - `setDockviewApi(api: DockviewApi): void` — stores and notifies listeners
  - `getDockviewApi(): DockviewApi | null` — null before the workbench mounts
  - `onDockviewApiChange(listener: () => void): () => void` — subscribe, returns unsubscribe

- [ ] **Step 1: Write the failing test**

```ts
// studio/frontend/src/state/dockviewApiRef.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setDockviewApi, getDockviewApi, onDockviewApiChange, _resetDockviewApiForTests } from './dockviewApiRef';
import type { DockviewApi } from 'dockview-react';

beforeEach(() => _resetDockviewApiForTests());

describe('dockviewApiRef', () => {
  it('is null before set, returns the api after', () => {
    expect(getDockviewApi()).toBeNull();
    const api = {} as DockviewApi;
    setDockviewApi(api);
    expect(getDockviewApi()).toBe(api);
  });

  it('notifies subscribers on set, and unsubscribe stops notifications', () => {
    const listener = vi.fn();
    const off = onDockviewApiChange(listener);
    setDockviewApi({} as DockviewApi);
    expect(listener).toHaveBeenCalledOnce();
    off();
    setDockviewApi({} as DockviewApi);
    expect(listener).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/state/dockviewApiRef.spec.ts`
Expected: FAIL with "Failed to resolve import ./dockviewApiRef".

- [ ] **Step 3: Write minimal implementation**

```ts
// studio/frontend/src/state/dockviewApiRef.ts
import type { DockviewApi } from 'dockview-react';

let current: DockviewApi | null = null;
const listeners = new Set<() => void>();

export function setDockviewApi(api: DockviewApi): void {
  current = api;
  listeners.forEach((l) => l());
}

export function getDockviewApi(): DockviewApi | null {
  return current;
}

export function onDockviewApiChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function _resetDockviewApiForTests(): void {
  current = null;
  listeners.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/state/dockviewApiRef.spec.ts`
Expected: 2 passed.

- [ ] **Step 5: Wire into `setupApp`**

In `studio/frontend/src/app/setupApp.ts`, add the import:

```ts
import { setDockviewApi } from '../state/dockviewApiRef';
```

and in the `attachDockview` closure (inside the `singleton = { ... }` literal) add `setDockviewApi(a);`:

```ts
attachDockview: (a: DockviewApi) => {
  api = a;
  setDockviewApi(a);
  layoutService.attach(a);
  if (!import.meta.env.PROD) (window as unknown as { __wbApi?: unknown }).__wbApi = a;
},
```

- [ ] **Step 6: Run the app-level suites to make sure nothing broke**

Run: `cd studio/frontend && npx vitest run src/app src/state src/host`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add studio/frontend/src/state/dockviewApiRef.ts studio/frontend/src/state/dockviewApiRef.spec.ts studio/frontend/src/app/setupApp.ts
git commit -m "feat(studio): dockviewApiRef state ref for shell components"
```

---

### Task 3: `NavRail` component

**Files:**

- Create: `studio/frontend/src/app/NavRail.tsx`
- Create: `studio/frontend/src/app/NavRail.spec.tsx`

**Interfaces:**

- Consumes: `getHost()` from `../state/hostRef` (`host.listPanes(): IPaneDef[]`, `host.openPane(id)`); `getDockviewApi` / `onDockviewApiChange` from `../state/dockviewApiRef` (Task 2); `host.openPane` semantics from Task 1.
- Produces: `NavRail` React component (no props). Testids: `nav-rail` on the container, `rail-open-<paneId>` per button. Task 4 renders it in `Workbench.tsx` and the e2e spec clicks `rail-open-math/viewer`.

- [ ] **Step 1: Write the failing test**

```tsx
// studio/frontend/src/app/NavRail.spec.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { setHost } from '../state/hostRef';
import { setDockviewApi, _resetDockviewApiForTests } from '../state/dockviewApiRef';
import { NavRail } from './NavRail';
import type { IPluginHost } from '../host/types';
import type { DockviewApi } from 'dockview-react';

const openPane = vi.fn();

function fakeHost(panes: Array<{ id: string; title: string }>): IPluginHost {
  return {
    registerPane: vi.fn(),
    registerCommand: vi.fn(),
    openPane,
    runCommand: vi.fn(),
    listPanes: () => panes.map((p) => ({ ...p, component: () => null }) as never),
    listCommands: () => [],
    resetLayout: vi.fn(),
  };
}

const PANES = [
  { id: 'llm-chat/room', title: 'Chat Room' },
  { id: 'llm-chat/settings', title: 'Chat Settings' },
  { id: 'llm-chat/skill-editor', title: 'Skill Editor' },
  { id: 'gdd/viewer', title: 'Game Design Doc' },
  { id: 'game/preview', title: 'Game Scene' },
  { id: 'assets/board', title: 'Asset Board' },
  { id: 'math/viewer', title: 'Math' },
];

beforeEach(() => {
  openPane.mockClear();
  _resetDockviewApiForTests();
  setHost(fakeHost(PANES));
});

describe('NavRail', () => {
  it('renders one launcher per registered pane, curated order first, utilities last', () => {
    render(<NavRail />);
    const ids = screen.getAllByRole('button').map((b) => b.getAttribute('data-testid'));
    expect(ids).toEqual([
      'rail-open-llm-chat/room',
      'rail-open-gdd/viewer',
      'rail-open-game/preview',
      'rail-open-assets/board',
      'rail-open-math/viewer',
      'rail-open-llm-chat/settings',
      'rail-open-llm-chat/skill-editor',
    ]);
  });

  it('puts unknown panes at the end of the top stack with a letter fallback', () => {
    setHost(fakeHost([...PANES, { id: 'mystery/pane', title: 'Zephyr' }]));
    render(<NavRail />);
    const btn = screen.getByTestId('rail-open-mystery/pane');
    expect(btn).toHaveTextContent('Z');
    const ids = screen.getAllByRole('button').map((b) => b.getAttribute('data-testid'));
    // after the curated top groups, before the bottom-anchored utilities
    expect(ids.indexOf('rail-open-mystery/pane')).toBeGreaterThan(ids.indexOf('rail-open-math/viewer'));
    expect(ids.indexOf('rail-open-mystery/pane')).toBeLessThan(ids.indexOf('rail-open-llm-chat/settings'));
  });

  it('clicking a launcher opens that pane', () => {
    render(<NavRail />);
    fireEvent.click(screen.getByTestId('rail-open-math/viewer'));
    expect(openPane).toHaveBeenCalledWith('math/viewer');
  });

  it('tints the active pane and brightens open panes once the Dockview api attaches', () => {
    render(<NavRail />);
    // before attach: everything renders in the closed tier
    expect(screen.getByTestId('rail-open-game/preview').className).toContain('text-muted-foreground');

    const api = {
      getPanel: (id: string) => (id === 'game/preview' || id === 'llm-chat/room' ? {} : undefined),
      activePanel: { id: 'game/preview' },
      onDidLayoutChange: () => ({ dispose: vi.fn() }),
      onDidActivePanelChange: () => ({ dispose: vi.fn() }),
    } as unknown as DockviewApi;
    act(() => setDockviewApi(api));

    expect(screen.getByTestId('rail-open-game/preview').className).toContain('bg-selection');
    expect(screen.getByTestId('rail-open-llm-chat/room').className).toContain('text-foreground');
    expect(screen.getByTestId('rail-open-math/viewer').className).toContain('text-muted-foreground');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/app/NavRail.spec.tsx`
Expected: FAIL with "Failed to resolve import ./NavRail".

- [ ] **Step 3: Write the implementation**

```tsx
// studio/frontend/src/app/NavRail.tsx
import { useEffect, useState, type ComponentType } from 'react';
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
} from 'lucide-react';
import { getHost } from '../state/hostRef';
import { getDockviewApi, onDockviewApiChange } from '../state/dockviewApiRef';
import type { IPaneDef } from '../host/types';

// Central curation (spec approach A): icons + journey grouping live here, not on
// IPaneDef. Panes missing from the map still render (letter fallback, trailing
// group) — the rail never hides a registered pane.
const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  'llm-chat/room': MessageSquare,
  'gdd/viewer': FileText,
  'game/preview': Gamepad2,
  'property-inspector/panel': SlidersHorizontal,
  'assets/board': Images,
  'scene-graph/tree': ListTree,
  'region-overrides/preview': LayoutTemplate,
  'game-config/editor': Settings2,
  'game-structure/editor': Network,
  'math/viewer': Sigma,
  'llm-chat/settings': Settings,
  'llm-chat/skill-editor': SquarePen,
};

const GROUP_ORDER: string[][] = [
  ['llm-chat/room', 'gdd/viewer'], // design
  ['game/preview', 'property-inspector/panel', 'assets/board', 'scene-graph/tree', 'region-overrides/preview'], // art
  ['game-config/editor', 'game-structure/editor', 'math/viewer'], // math
];
const UTILITY_IDS = ['llm-chat/settings', 'llm-chat/skill-editor'];

// Re-render on Dockview layout/active-panel changes so open/active state stays
// honest. Before the api attaches, everything renders in the closed tier.
function useDockviewVersion(): void {
  const [, setVersion] = useState(0);
  useEffect(() => {
    let disposers: Array<{ dispose(): void }> = [];
    const bump = () => setVersion((v) => v + 1);
    const attach = () => {
      disposers.forEach((d) => d.dispose());
      disposers = [];
      const api = getDockviewApi();
      if (!api) return;
      disposers = [api.onDidLayoutChange(bump), api.onDidActivePanelChange(bump)];
      bump();
    };
    attach();
    const off = onDockviewApiChange(attach);
    return () => {
      off();
      disposers.forEach((d) => d.dispose());
    };
  }, []);
}

function RailButton({ pane }: { pane: IPaneDef }) {
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
      title={pane.title}
      onClick={() => host.openPane(pane.id)}
      className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-raised-hover hover:text-foreground ${tier}`}
    >
      {Icon ? <Icon aria-hidden className="h-4 w-4" /> : <span className="text-xs">{pane.title.charAt(0)}</span>}
    </button>
  );
}

export function NavRail() {
  const host = getHost();
  useDockviewVersion();
  const panes = new Map(host.listPanes().map((p) => [p.id, p]));
  const curated = new Set([...GROUP_ORDER.flat(), ...UTILITY_IDS]);
  const groups = GROUP_ORDER.map((ids) => ids.filter((id) => panes.has(id)).map((id) => panes.get(id)!)).filter((g) => g.length > 0);
  const rest = [...panes.values()].filter((p) => !curated.has(p.id));
  if (rest.length > 0) groups.push(rest);
  const utility = UTILITY_IDS.filter((id) => panes.has(id)).map((id) => panes.get(id)!);
  return (
    <nav data-testid="nav-rail" className="flex w-10 flex-shrink-0 flex-col items-center gap-1 border-r border-border bg-canvas py-2">
      {groups.map((group, gi) => (
        <div key={gi} className={`flex w-8 flex-col items-center gap-1 ${gi > 0 ? 'mt-1 border-t border-border pt-2' : ''}`}>
          {group.map((p) => (
            <RailButton key={p.id} pane={p} />
          ))}
        </div>
      ))}
      <div className="flex-1" />
      <div className="flex w-8 flex-col items-center gap-1">
        {utility.map((p) => (
          <RailButton key={p.id} pane={p} />
        ))}
      </div>
    </nav>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/app/NavRail.spec.tsx`
Expected: 4 passed.

- [ ] **Step 5: Run the design-language guard**

Run: `cd studio/frontend && npx vitest run src/design-language.guard.spec.ts`
Expected: PASS (no raw colors were introduced).

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/app/NavRail.tsx studio/frontend/src/app/NavRail.spec.tsx
git commit -m "feat(studio): NavRail pane-launcher component"
```

---

### Task 4: Render the rail in `Workbench` + e2e spec

**Files:**

- Modify: `studio/frontend/src/app/Workbench.tsx` (the `flex-1` Dockview wrapper, lines 50–52)
- Create: `studio/frontend/e2e/nav-rail.spec.ts`

**Interfaces:**

- Consumes: `NavRail` from `./NavRail` (Task 3); `gotoWorkbench` from `e2e/helpers`.
- Produces: the shipped shell layout — toolbar full-width on top, rail left of the Dockview area.

- [ ] **Step 1: Write the e2e spec (fails until the rail is rendered)**

```ts
// studio/frontend/e2e/nav-rail.spec.ts
import { test, expect } from '@playwright/test';
import { gotoWorkbench } from './helpers';

test('rail is visible and opens a closed pane', async ({ page }) => {
  await gotoWorkbench(page);
  await expect(page.getByTestId('nav-rail')).toBeVisible();
  // Default = Art layout: Math is not open (hermetic room has no game → *-no-game placeholders).
  await expect(page.getByTestId('math-no-game')).toHaveCount(0);
  await page.getByTestId('rail-open-math/viewer').click();
  await expect(page.getByTestId('math-no-game')).toBeVisible();
});

test('active tint follows the active panel', async ({ page }) => {
  await gotoWorkbench(page);
  await page.getByTestId('rail-open-math/viewer').click();
  await expect(page.getByTestId('math-no-game')).toBeVisible();
  await expect(page.getByTestId('rail-open-math/viewer')).toHaveClass(/bg-selection/);
  // Focus a different pane → the Math icon loses the tint.
  await page.getByTestId('rail-open-llm-chat/room').click();
  await expect(page.getByTestId('rail-open-math/viewer')).not.toHaveClass(/bg-selection/);
});
```

- [ ] **Step 2: Modify `Workbench.tsx`**

Add the import:

```tsx
import { NavRail } from './NavRail';
```

Replace the Dockview wrapper (currently `<div className="flex-1 overflow-hidden">...`):

```tsx
<div className="flex flex-1 overflow-hidden">
  <NavRail />
  <div className="flex-1 overflow-hidden">
    <DockviewReact theme={bloomTheme} components={app.components as never} onReady={(e: DockviewReadyEvent) => app.attachDockview(e.api)} />
  </div>
</div>
```

- [ ] **Step 3: Run the unit suite for the app dir (Workbench has no spec; guard against import breakage)**

Run: `cd studio/frontend && npx vitest run src/app`
Expected: all pass.

- [ ] **Step 4: Run the new e2e spec against the replay stack**

From the worktree root (offset 1 — ports 8001/4201/4301; the Playwright config reads `BLOOM_PORT_OFFSET` from `.env`):

```bash
just backend-serve-replay   # background, once — leave running for Task 5
just engine-serve           # background, once — Playwright does NOT boot the engine
npx playwright test --config=studio/frontend/playwright.config.ts nav-rail.spec.ts
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/app/Workbench.tsx studio/frontend/e2e/nav-rail.spec.ts
git commit -m "feat(studio): render NavRail in the workbench shell"
```

---

### Task 5: Full gates, reference screenshot, PR

**Files:**

- Modify (expected, produced by the e2e fidelity step): `docs/design-language/reference-workbench.png`

**Interfaces:**

- Consumes: everything above.
- Produces: green branch + open PR.

- [ ] **Step 1: Frontend CI gates (all four — vitest green alone is not enough)**

```bash
node_modules/.bin/prettier --check .
npx nx run-many -t typecheck
npx nx run-many -t test
npx nx run-many -t build
```

Expected: all green. Known pre-existing exception: 3 port-hardcoded game-plugin tests fail in any offset≠0 worktree — confirm any test failures are exactly those, unrelated to this branch.

- [ ] **Step 2: Full e2e suite (replay backend from Task 4 still running)**

```bash
just e2e
```

Expected: all specs green (the suite carries a known roaming ~1/113 contention flake — re-run any single red in isolation before treating it as real). This re-shoots `docs/design-language/reference-workbench.png` — the diff now shows the rail, which is the point.

- [ ] **Step 3: Commit the re-shot reference screenshot**

```bash
git add docs/design-language/reference-workbench.png
git commit -m "docs(design-language): re-shoot workbench reference with nav rail"
```

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/navrail
gh pr create --title "feat(studio): navigation rail (workbench UX pass 2)" --body "$(cat <<'EOF'
## Summary

Workbench UX pass 2 (spec: docs/superpowers/specs/2026-07-14-workbench-navrail-design.md, deferred from #198):

- **NavRail** — always-visible left icon rail; one launcher per registered pane (journey-grouped curation map, letter fallback for unknown panes), native tooltips, `rail-open-<paneId>` testids.
- **Honest open/active state** — open panes brighten, the active panel gets the `--selection` tint; rail subscribes to Dockview layout/active-panel events via a new `dockviewApiRef`.
- **`openPane` already-active guard** — no-ops instead of re-activating, killing the pointless engine-iframe reload (issue #200's no-op case) for every caller.
- View menu, palette, PhaseSwitcher untouched.

## Testing

Unit (host guard, apiRef, NavRail order/fallback/state) + new `nav-rail.spec.ts` e2e + full `just e2e` on replay backend (offset-1 ports). Reference screenshot re-shot.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed. Report it and stop — merge goes through `/bloom:complete-work` after CI.

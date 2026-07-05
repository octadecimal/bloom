# Param Sidebar Second Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Math pane's param sidebar drag-resizable, extract its shell (toggle + persisted visibility/width + resize handle) into a reusable `components/ui/PaneSidebar`, regroup the 18 fields into 6 semantic groups, and give group headers a visual tier above field labels.

**Architecture:** A new `PaneSidebar` primitive (hook + column component + toggle button, no context) owns UI-preference persistence (`{open, width}` JSON in localStorage) and the resize handle. The math plugin keeps its field registry and composes the shell. Regrouping is a re-tag + reorder of `paramFields.ts`; hierarchy is a two-class change in `ParamSidebar.tsx`.

**Tech Stack:** React 18 + TypeScript, hookstate, Tailwind v4 tokens (design language), lucide-react, vitest + @testing-library/react, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-07-05-param-sidebar-second-pass-design.md`

## Global Constraints

- Worktree: `C:\code\bloom.wt\param-sidebar-2`, branch `feat/param-sidebar-2`, `BLOOM_PORT_OFFSET=1` (backend :8001, frontend :4201). All commands run from the worktree root unless stated.
- TypeScript interfaces use an `I` prefix (`IPaneSidebarProps`) — `docs/coding-standards.md`.
- No raw colors outside `styles.css` — the design-language guard spec fails the build otherwise. Token utilities only (`border-hairline`, `bg-hairline-strong`, `text-text-1`, `text-text-2`, `text-accent-text`, `bg-raised-hover`).
- Testids `advanced-toggle`, `advanced-params`, `param-*` (incl. `param-master-seed`, `param-pool-size`) MUST keep working.
- localStorage key stays `bloom.math.sidebar`; legacy `'1'`/`'0'` values must still be understood.
- Width clamps 200–420, default 240. Keyboard resize step 16px.
- Semantic commits. Gates before PR: `node_modules/.bin/prettier --check .` (pinned — never bare `npx prettier` in a fresh worktree), `npx nx typecheck frontend`, `npx nx test frontend`, `npx nx build frontend` (unit gates with `BLOOM_PORT_OFFSET=0` in the environment), then `just e2e` against a replay backend on the worktree's offset ports.
- `just` recipes need `sh` on PATH; if PowerShell can't find it, run the recipe's commands via the Bash tool (Git Bash) instead.

---

### Task 1: `PaneSidebar` shell primitive

**Files:**

- Create: `studio/frontend/src/components/ui/PaneSidebar.tsx`
- Test: `studio/frontend/src/components/ui/PaneSidebar.spec.tsx`

**Interfaces:**

- Consumes: nothing project-specific (localStorage, lucide icon type).
- Produces (Task 3 relies on these exact names):
  - `usePaneSidebar(storageKey: string, opts?: { defaultWidth?: number }): IPaneSidebarState` where `IPaneSidebarState = { open: boolean; width: number; toggle: () => void; setWidth: (w: number) => void }`
  - `PaneSidebar({ width, onWidthChange, children }: IPaneSidebarProps)` — renders `data-testid="pane-sidebar"` root and `data-testid="sidebar-resize"` handle
  - `PaneSidebarToggle({ open, onToggle, icon, title, testId }: IPaneSidebarToggleProps)`

- [ ] **Step 1: Bootstrap the worktree deps (once)**

From `C:\code\bloom.wt\param-sidebar-2`: run `npm install` (backend `uv sync` is NOT needed for this frontend-only branch until the e2e task; do it in Task 4).

- [ ] **Step 2: Write the failing test**

Create `studio/frontend/src/components/ui/PaneSidebar.spec.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SlidersHorizontal } from 'lucide-react';
import { PaneSidebar, PaneSidebarToggle, usePaneSidebar } from './PaneSidebar';

const KEY = 'test.pane.sidebar';

function Harness() {
  const sb = usePaneSidebar(KEY);
  return (
    <div>
      <PaneSidebarToggle open={sb.open} onToggle={sb.toggle} icon={SlidersHorizontal} title="Params" testId="toggle" />
      {sb.open && (
        <PaneSidebar width={sb.width} onWidthChange={sb.setWidth}>
          <div data-testid="content" />
        </PaneSidebar>
      )}
    </div>
  );
}

beforeEach(() => localStorage.clear());

describe('usePaneSidebar', () => {
  it('defaults closed at 240 and persists {open, width} JSON on toggle', () => {
    render(<Harness />);
    const toggle = screen.getByTestId('toggle');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByTestId('content')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByTestId('content')).toBeTruthy();
    expect(screen.getByTestId('pane-sidebar').style.width).toBe('240px');
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ open: true, width: 240 });
  });

  it('migrates legacy "1"/"0" open flags', () => {
    localStorage.setItem(KEY, '1');
    render(<Harness />);
    expect(screen.getByTestId('toggle').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('pane-sidebar').style.width).toBe('240px');
  });

  it('restores persisted JSON, clamping width to 200–420', () => {
    localStorage.setItem(KEY, JSON.stringify({ open: true, width: 9999 }));
    render(<Harness />);
    expect(screen.getByTestId('pane-sidebar').style.width).toBe('420px');
  });

  it('falls back to defaults on malformed values', () => {
    localStorage.setItem(KEY, '{nope');
    render(<Harness />);
    expect(screen.getByTestId('toggle').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('PaneSidebar resize handle', () => {
  beforeEach(() => localStorage.setItem(KEY, JSON.stringify({ open: true, width: 240 })));

  it('pointer drag left widens, clamped at 420, and persists', () => {
    render(<Harness />);
    const handle = screen.getByTestId('sidebar-resize');
    fireEvent.pointerDown(handle, { clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 220, pointerId: 1 }); // 80px left → wider
    expect(screen.getByTestId('pane-sidebar').style.width).toBe('320px');
    fireEvent.pointerMove(handle, { clientX: -9999, pointerId: 1 });
    expect(screen.getByTestId('pane-sidebar').style.width).toBe('420px');
    fireEvent.pointerUp(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 0, pointerId: 1 }); // drag ended → ignored
    expect(screen.getByTestId('pane-sidebar').style.width).toBe('420px');
    expect(JSON.parse(localStorage.getItem(KEY)!).width).toBe(420);
  });

  it('arrow keys resize by 16px within clamps', () => {
    render(<Harness />);
    const handle = screen.getByTestId('sidebar-resize');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(screen.getByTestId('pane-sidebar').style.width).toBe('256px');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(screen.getByTestId('pane-sidebar').style.width).toBe('224px');
  });

  it('is an accessible vertical separator', () => {
    render(<Harness />);
    const handle = screen.getByTestId('sidebar-resize');
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('tabindex')).toBe('0');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx nx test frontend -- src/components/ui/PaneSidebar.spec.tsx`
Expected: FAIL — cannot resolve `./PaneSidebar`.

- [ ] **Step 4: Write the implementation**

Create `studio/frontend/src/components/ui/PaneSidebar.tsx`:

```tsx
import { useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';

const MIN_WIDTH = 200;
const MAX_WIDTH = 420;
const DEFAULT_WIDTH = 240;
const KEY_STEP = 16;

const clampWidth = (w: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)));

interface ISidebarPrefs {
  open: boolean;
  width: number;
}

function loadPrefs(storageKey: string, defaultWidth: number): ISidebarPrefs {
  const raw = localStorage.getItem(storageKey);
  // Legacy format from the pre-resize sidebar hook: bare '1' / '0'.
  if (raw === '1' || raw === '0') return { open: raw === '1', width: defaultWidth };
  try {
    const p = JSON.parse(raw ?? '') as Partial<ISidebarPrefs> | null;
    if (p && typeof p.open === 'boolean' && typeof p.width === 'number') {
      return { open: p.open, width: clampWidth(p.width) };
    }
  } catch {
    /* malformed → defaults */
  }
  return { open: false, width: defaultWidth };
}

export interface IPaneSidebarState {
  open: boolean;
  width: number;
  toggle: () => void;
  setWidth: (w: number) => void;
}

/** Per-pane sidebar preference (UI preference, not game data): visibility +
 * width, persisted as {open, width} JSON under the caller's storage key. */
export function usePaneSidebar(storageKey: string, opts?: { defaultWidth?: number }): IPaneSidebarState {
  const defaultWidth = clampWidth(opts?.defaultWidth ?? DEFAULT_WIDTH);
  const [prefs, setPrefs] = useState(() => loadPrefs(storageKey, defaultWidth));
  const update = (fn: (p: ISidebarPrefs) => ISidebarPrefs) =>
    setPrefs((p) => {
      const next = fn(p);
      localStorage.setItem(storageKey, JSON.stringify(next));
      return next;
    });
  return {
    open: prefs.open,
    width: prefs.width,
    toggle: () => update((p) => ({ ...p, open: !p.open })),
    setWidth: (w: number) => update((p) => ({ ...p, width: clampWidth(w) })),
  };
}

export interface IPaneSidebarProps {
  width: number;
  onWidthChange: (w: number) => void;
  children: ReactNode;
}

/** Resizable right-hand sidebar column: hairline left border with a drag
 * handle (pointer + arrow keys) straddling it. Clamping lives in the hook's
 * setWidth so there is exactly one clamp. */
export function PaneSidebar({ width, onWidthChange, children }: IPaneSidebarProps) {
  const drag = useRef<{ startX: number; startW: number } | null>(null);
  return (
    <div data-testid="pane-sidebar" className="relative flex-none border-l border-hairline" style={{ width }}>
      <div
        data-testid="sidebar-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        tabIndex={0}
        onPointerDown={(e) => {
          drag.current = { startX: e.clientX, startW: width };
          // Optional-chained: jsdom has no pointer-capture implementation.
          e.currentTarget.setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current) onWidthChange(drag.current.startW + drag.current.startX - e.clientX);
        }}
        onPointerUp={() => (drag.current = null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') (e.preventDefault(), onWidthChange(width + KEY_STEP));
          if (e.key === 'ArrowRight') (e.preventDefault(), onWidthChange(width - KEY_STEP));
        }}
        className="absolute -left-1 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-hairline-strong focus-visible:bg-hairline-strong focus-visible:outline-none"
      />
      <div className="h-full overflow-y-auto">{children}</div>
    </div>
  );
}

export interface IPaneSidebarToggleProps {
  open: boolean;
  onToggle: () => void;
  icon: ComponentType<{ className?: string }>;
  title: string;
  testId: string;
}

/** Ghost icon button that opens/closes a pane sidebar (accent text when open). */
export function PaneSidebarToggle({ open, onToggle, icon: Icon, title, testId }: IPaneSidebarToggleProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={open}
      title={title}
      onClick={onToggle}
      className={`rounded p-1 hover:bg-raised-hover ${open ? 'text-accent-text' : 'text-text-2'}`}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx nx test frontend -- src/components/ui/PaneSidebar.spec.tsx`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/components/ui/PaneSidebar.tsx studio/frontend/src/components/ui/PaneSidebar.spec.tsx
git commit -m "feat(ui): PaneSidebar shell - persisted width/visibility + resize handle"
```

---

### Task 2: Regroup the field registry into 6 semantic groups

**Files:**

- Modify: `studio/frontend/src/plugins/math/components/paramFields.ts`
- Test: `studio/frontend/src/plugins/math/components/paramFields.spec.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `IParamGroup = 'search' | 'genetics' | 'weights' | 'verification' | 'pool' | 'repro'`; `PARAM_GROUPS` in that order with labels `Search budget`, `Genetic operators`, `Fitness weights`, `Verification`, `Pool`, `Reproducibility`. Field keys, labels, tooltips, constraints, accessors, and `resetGroup(s, group)` are unchanged. Task 3's reset testids derive from the new ids (`param-reset-search`, …).

- [ ] **Step 1: Update the registry tests to the 6-group scheme**

In `studio/frontend/src/plugins/math/components/paramFields.spec.ts`, replace the `'has three groups, each non-empty'` test with:

```ts
it('has six semantic groups, each non-empty', () => {
  expect(PARAM_GROUPS.map((g) => g.id)).toEqual(['search', 'genetics', 'weights', 'verification', 'pool', 'repro']);
  for (const g of PARAM_GROUPS) {
    expect(PARAM_FIELDS.some((f) => f.group === g.id)).toBe(true);
  }
});

it('assigns every field to its spec group, in spec order', () => {
  const byGroup = (id: string) => PARAM_FIELDS.filter((f) => f.group === id).map((f) => f.key);
  expect(byGroup('search')).toEqual(['population', 'generations', 'search-spins', 'final-spins', 'stagnation']);
  expect(byGroup('genetics')).toEqual(['mutation', 'crossover', 'elitism']);
  expect(byGroup('weights')).toEqual(['weight-rtp', 'weight-volatility', 'weight-hit-rate']);
  expect(byGroup('verification')).toEqual(['candidates', 'rtp-tolerance', 'bonus-tolerance']);
  expect(byGroup('pool')).toEqual(['pool-size', 'correction-band']);
  expect(byGroup('repro')).toEqual(['master-seed', 'sim-seed']);
});
```

and replace the `'resetGroup restores only its own group'` test with:

```ts
it('resetGroup restores only its own group — repro spans both slices', () => {
  const s = mathSlice();
  s.tunerParams.set({ ...tunerParams, population: 99, masterSeed: 7, weights: { ...tunerParams.weights, rtp: 9 } });
  s.curationParams.set({ ...curationParams, poolSize: 77, masterSeed: 8 });
  resetGroup(s, 'search');
  expect(s.tunerParams.get()?.population).toBe(24);
  expect(s.tunerParams.get()?.masterSeed).toBe(7); // repro is its own group
  expect(s.tunerParams.get()?.weights.rtp).toBe(9); // weights is its own group
  expect(s.curationParams.get()?.poolSize).toBe(77); // pool untouched
  resetGroup(s, 'pool');
  expect(s.curationParams.get()?.poolSize).toBe(1000);
  resetGroup(s, 'repro');
  expect(s.tunerParams.get()?.masterSeed).toBe(2026);
  expect(s.curationParams.get()?.masterSeed).toBe(2026);
});
```

All other tests in the file stay as they are (they are group-agnostic).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx nx test frontend -- src/plugins/math/components/paramFields.spec.ts`
Expected: FAIL — group ids still `tuner|weights|curation`, `resetGroup(s, 'search')` has type error / wrong behavior.

- [ ] **Step 3: Re-tag and reorder the registry**

In `studio/frontend/src/plugins/math/components/paramFields.ts`:

1. Replace the group type and list:

```ts
export type IParamGroup = 'search' | 'genetics' | 'weights' | 'verification' | 'pool' | 'repro';
```

```ts
export const PARAM_GROUPS: { id: IParamGroup; label: string }[] = [
  { id: 'search', label: 'Search budget' },
  { id: 'genetics', label: 'Genetic operators' },
  { id: 'weights', label: 'Fitness weights' },
  { id: 'verification', label: 'Verification' },
  { id: 'pool', label: 'Pool' },
  { id: 'repro', label: 'Reproducibility' },
];
```

2. Re-tag each field's `group:` and reorder the `PARAM_FIELDS` entries into group order (render order = registry order filtered by group; move whole entry blocks, change nothing inside them except `group:`):

| Order | key                 | new `group:`     |
| ----- | ------------------- | ---------------- |
| 1     | `population`        | `'search'`       |
| 2     | `generations`       | `'search'`       |
| 3     | `search-spins`      | `'search'`       |
| 4     | `final-spins`       | `'search'`       |
| 5     | `stagnation`        | `'search'`       |
| 6     | `mutation`          | `'genetics'`     |
| 7     | `crossover`         | `'genetics'`     |
| 8     | `elitism`           | `'genetics'`     |
| 9     | `weight-rtp`        | `'weights'`      |
| 10    | `weight-volatility` | `'weights'`      |
| 11    | `weight-hit-rate`   | `'weights'`      |
| 12    | `candidates`        | `'verification'` |
| 13    | `rtp-tolerance`     | `'verification'` |
| 14    | `bonus-tolerance`   | `'verification'` |
| 15    | `pool-size`         | `'pool'`         |
| 16    | `correction-band`   | `'pool'`         |
| 17    | `master-seed`       | `'repro'`        |
| 18    | `sim-seed`          | `'repro'`        |

Update the `// ── tuner ──` style section comments to the new group names. `resetGroup` needs no change (field-driven).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx nx test frontend -- src/plugins/math/components/paramFields.spec.ts`
Expected: PASS. (`ParamSidebar.spec.tsx` and possibly `MathPane.spec.tsx` will now FAIL — they still assert the old group labels/reset ids. That is expected mid-branch; Task 3 fixes them. Do NOT run the full suite as a gate here.)

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/math/components/paramFields.ts studio/frontend/src/plugins/math/components/paramFields.spec.ts
git commit -m "feat(math): regroup param registry into 6 semantic groups"
```

---

### Task 3: Integrate the shell into the Math pane + header hierarchy

**Files:**

- Modify: `studio/frontend/src/plugins/math/components/ParamSidebar.tsx`
- Modify: `studio/frontend/src/plugins/math/MathPane.tsx`
- Test: `studio/frontend/src/plugins/math/components/ParamSidebar.spec.tsx`
- Test: `studio/frontend/src/plugins/math/MathPane.spec.tsx` (the two sidebar tests near the end)

**Interfaces:**

- Consumes: `usePaneSidebar` / `PaneSidebar` / `PaneSidebarToggle` from Task 1 (exact signatures in Task 1's Produces block); `PARAM_GROUPS` 6-group list from Task 2.
- Produces: `ParamSidebar()` — now a width-agnostic content column (`data-testid="advanced-params"`, no `w-60`, no border); `useParamSidebarOpen` is DELETED (nothing else imports it — verify with grep in Step 3).

- [ ] **Step 1: Update the sidebar + pane tests**

Replace the whole of `studio/frontend/src/plugins/math/components/ParamSidebar.spec.tsx` with (drops the old `useParamSidebarOpen` harness — that behavior now lives in `PaneSidebar.spec.tsx`):

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ParamSidebar } from './ParamSidebar';
import { MATH_PLUGIN_ID, makeInitialState, mathSlice } from '../state';
import { rootStore } from '../../../state/rootStore';

const tunerParams = {
  masterSeed: 2026,
  population: 24,
  maxGenerations: 40,
  searchCandidateCount: 20000,
  finalCandidateCount: 200000,
  elitism: 2,
  mutationRate: 0.25,
  crossoverRate: 0.9,
  stagnationWindow: 12,
  weights: { rtp: 1, volatility: 1, hitRate: 1 },
};

const curationParams = {
  poolSize: 500,
  candidateCount: 20000,
  masterSeed: 2026,
  rtpTolerance: 0.02,
  realizedCorrectionBand: 0.05,
  bonusRateTolerance: 0.25,
};

beforeEach(() => {
  localStorage.clear();
  rootStore.plugins.nested(MATH_PLUGIN_ID).set(makeInitialState() as never);
  mathSlice().tunerParams.set({ ...tunerParams, weights: { ...tunerParams.weights } });
  mathSlice().curationParams.set({ ...curationParams });
});

describe('ParamSidebar', () => {
  it('renders the six semantic groups with their fields', () => {
    render(<ParamSidebar />);
    expect(screen.getByTestId('advanced-params')).toBeTruthy();
    for (const label of ['Search budget', 'Genetic operators', 'Fitness weights', 'Verification', 'Pool', 'Reproducibility']) {
      expect(screen.getByText(label, { exact: true }), label).toBeTruthy();
    }
    expect(screen.getByTestId('param-master-seed')).toBeTruthy();
    expect(screen.getByTestId('param-crossover')).toBeTruthy();
    expect(screen.getByTestId('param-weight-rtp')).toBeTruthy();
    expect(screen.getByTestId('param-pool-size')).toBeTruthy();
  });

  it('group headers read a tier above field labels (text-1 + hairline divider)', () => {
    render(<ParamSidebar />);
    const header = screen.getByText('Search budget', { exact: true });
    expect(header.className).toContain('text-text-1');
    expect(header.parentElement!.className).toContain('border-b');
    const fieldLabel = screen.getByText('Population', { exact: true });
    expect(fieldLabel.closest('span[tabindex]')!.className).toContain('text-text-2');
  });

  it('group reset restores only its own group — including across slices', () => {
    render(<ParamSidebar />);
    fireEvent.change(screen.getByTestId('param-population'), { target: { value: '50' } });
    fireEvent.change(screen.getByTestId('param-pool-size'), { target: { value: '700' } });
    fireEvent.click(screen.getByTestId('param-reset-search'));
    expect(mathSlice().tunerParams.get()?.population).toBe(24);
    expect(mathSlice().curationParams.get()?.poolSize).toBe(700);
    fireEvent.change(screen.getByTestId('param-master-seed'), { target: { value: '7' } });
    fireEvent.change(screen.getByTestId('param-sim-seed'), { target: { value: '8' } });
    fireEvent.click(screen.getByTestId('param-reset-repro'));
    expect(mathSlice().tunerParams.get()?.masterSeed).toBe(2026);
    expect(mathSlice().curationParams.get()?.masterSeed).toBe(2026);
  });
});
```

In `studio/frontend/src/plugins/math/MathPane.spec.tsx`, update the two sidebar tests:

- In `'opens the param sidebar from the header toggle and persists the choice'`, replace the last assertion line

```tsx
expect(localStorage.getItem('bloom.math.sidebar')).toBe('1');
```

with

```tsx
expect(JSON.parse(localStorage.getItem('bloom.math.sidebar')!)).toMatchObject({ open: true });
```

- `'restores a persisted-open sidebar on mount'` stays EXACTLY as is (it seeds legacy `'1'` — it now proves the migration path through the real pane).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx nx test frontend -- src/plugins/math/components/ParamSidebar.spec.tsx src/plugins/math/MathPane.spec.tsx`
Expected: FAIL — old group labels, `param-reset-search` missing, header still `text-text-2`, localStorage still `'1'`.

- [ ] **Step 3: Rewrite ParamSidebar and rewire MathPane**

Replace the whole of `studio/frontend/src/plugins/math/components/ParamSidebar.tsx` with:

```tsx
import { RotateCcw } from 'lucide-react';
import { TooltipProvider } from '../../../components/ui/tooltip';
import { mathSlice } from '../state';
import { PARAM_FIELDS, PARAM_GROUPS, resetGroup } from './paramFields';
import { ParamField } from './ParamField';

/** The params column CONTENT; the resizable shell around it is
 * components/ui/PaneSidebar (MathPane composes the two). Edits land in the
 * slice; they persist via the PUT that precedes every Generate
 * (tuner_params) / Verify (params) — see actions.ts. */
export function ParamSidebar() {
  return (
    <div data-testid="advanced-params" className="p-3">
      <TooltipProvider delayDuration={300}>
        <div className="flex flex-col gap-4">
          {PARAM_GROUPS.map((g) => (
            <section key={g.id}>
              <div className="mb-2 flex items-center justify-between border-b border-hairline pb-1.5">
                <span className="text-[10px] uppercase tracking-wide text-text-1">{g.label}</span>
                <button
                  type="button"
                  data-testid={`param-reset-${g.id}`}
                  title={`Reset ${g.label.toLowerCase()} to defaults`}
                  aria-label={`Reset ${g.label.toLowerCase()} to defaults`}
                  onClick={() => resetGroup(mathSlice(), g.id)}
                  className="rounded p-0.5 text-text-3 hover:bg-raised-hover hover:text-text-1"
                >
                  <RotateCcw className="h-3 w-3" />
                </button>
              </div>
              <div className="flex flex-col gap-1.5">
                {PARAM_FIELDS.filter((f) => f.group === g.id).map((f) => (
                  <ParamField key={f.key} def={f} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </TooltipProvider>
    </div>
  );
}
```

(`useParamSidebarOpen`, `STORAGE_KEY`, and the `useState` import are gone; the root div lost `w-60 flex-none overflow-y-auto border-l border-hairline` — the shell owns those. Verify nothing else imports the deleted hook: `grep -r useParamSidebarOpen studio/frontend/src` must return only MathPane, fixed next.)

In `studio/frontend/src/plugins/math/MathPane.tsx`:

1. Replace the import

```tsx
import { ParamSidebar, useParamSidebarOpen } from './components/ParamSidebar';
```

with

```tsx
import { PaneSidebar, PaneSidebarToggle, usePaneSidebar } from '../../components/ui/PaneSidebar';
import { ParamSidebar } from './components/ParamSidebar';
```

2. Replace

```tsx
const [sidebarOpen, toggleSidebar] = useParamSidebarOpen();
```

with

```tsx
const sidebar = usePaneSidebar('bloom.math.sidebar');
```

3. Replace the whole header toggle `<button …>…</button>` block (`data-testid="advanced-toggle"`) with

```tsx
<PaneSidebarToggle open={sidebar.open} onToggle={sidebar.toggle} icon={SlidersHorizontal} title="Tuning parameters" testId="advanced-toggle" />
```

(keep the `SlidersHorizontal` lucide import).

4. Replace

```tsx
{
  sidebarOpen && <ParamSidebar />;
}
```

with

```tsx
{
  sidebar.open && (
    <PaneSidebar width={sidebar.width} onWidthChange={sidebar.setWidth}>
      <ParamSidebar />
    </PaneSidebar>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx nx test frontend -- src/plugins/math/components/ParamSidebar.spec.tsx src/plugins/math/MathPane.spec.tsx src/components/ui/PaneSidebar.spec.tsx`
Expected: PASS.

- [ ] **Step 5: Run the full frontend unit + type gates**

Run (from the worktree root, with `BLOOM_PORT_OFFSET=0` in the environment):

```
npx nx typecheck frontend
npx nx test frontend
```

Expected: both green — this catches any straggler importing the deleted hook or old group ids (the design-language guard spec runs inside `nx test`).

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/plugins/math/components/ParamSidebar.tsx studio/frontend/src/plugins/math/components/ParamSidebar.spec.tsx studio/frontend/src/plugins/math/MathPane.tsx studio/frontend/src/plugins/math/MathPane.spec.tsx
git commit -m "feat(math): resizable param sidebar via shared PaneSidebar shell + header tier"
```

---

### Task 4: E2e coverage + full gates

**Files:**

- Modify: `studio/frontend/e2e/math-plugin.spec.ts` (append a test; reuse the file's existing `setupGame` / `openMath` helpers and `MODEL_09` / `FAST_SIM_PARAMS` fixtures)

**Interfaces:**

- Consumes: testids `advanced-toggle`, `advanced-params`, `pane-sidebar`, `sidebar-resize` (Tasks 1+3); the 6 group labels (Task 2).
- Produces: nothing downstream — this is the behavioral contract.

- [ ] **Step 1: Prep the e2e environment**

From the worktree root (Bash tool if `just` can't find `sh` in PowerShell):

```bash
cd studio/backend && uv sync && cd ../..
cargo build --release -p bloom-simulator -p bloom-tuner
just backend-serve-replay   # background; worktree .env has BLOOM_PORT_OFFSET=1 → :8001
```

NEVER use the default :8000/:4200 ports — another session may hold them (worktree rule). The Vite/Playwright configs read `BLOOM_PORT_OFFSET` from the worktree `.env`.

- [ ] **Step 2: Append the e2e test**

At the end of `studio/frontend/e2e/math-plugin.spec.ts`:

```ts
// ---------------------------------------------------------------------------
// Test 7 — param sidebar shell (second pass): six semantic groups render;
// drag-resize persists across reload (observable end-state: the rendered
// width after reload, not the dispatch).
// ---------------------------------------------------------------------------

test('param sidebar: semantic groups render and drag-resize persists across reload', async ({ page, request }) => {
  const roomName = `sidebar2 ${Date.now()}`;
  await setupGame(page, request, 'erin', roomName, {
    model: MODEL_09,
    simParams: FAST_SIM_PARAMS,
    intent: { rtp: '90%', volatility: 'low' },
  });
  await openMath(page);

  await page.getByTestId('advanced-toggle').click();
  await expect(page.getByTestId('advanced-params')).toBeVisible();
  for (const label of ['Search budget', 'Genetic operators', 'Fitness weights', 'Verification', 'Pool', 'Reproducibility']) {
    await expect(page.getByTestId('advanced-params').getByText(label, { exact: true })).toBeVisible();
  }

  // Drag the handle 80px left → sidebar widens from 240 to ~320.
  const handle = page.getByTestId('sidebar-resize');
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 80, box.y + 200, { steps: 4 });
  await page.mouse.up();
  const widened = (await page.getByTestId('pane-sidebar').boundingBox())!.width;
  expect(widened).toBeGreaterThan(300);

  // Reload: open state AND width reconcile from the persisted preference.
  await page.reload();
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
  await openMath(page);
  await expect(page.getByTestId('advanced-params')).toBeVisible();
  const after = (await page.getByTestId('pane-sidebar').boundingBox())!.width;
  expect(Math.abs(after - widened)).toBeLessThan(2);
});
```

- [ ] **Step 3: Run the math e2e spec**

From `studio/frontend` (worktree), with the replay backend from Step 1 up:

```bash
BLOOM_PORT_OFFSET=1 npx playwright test e2e/math-plugin.spec.ts
```

Expected: all math-plugin tests PASS — the pre-existing test 6 proves the preserved testids; the new test 7 proves groups + resize persistence. If test 7's reload lands somewhere unexpected, mirror the reload pattern in `game-config.spec.ts:191`.

- [ ] **Step 4: Commit**

```bash
git add studio/frontend/e2e/math-plugin.spec.ts
git commit -m "test(math): e2e for sidebar groups + drag-resize persistence"
```

- [ ] **Step 5: Full gates**

From the worktree root:

```bash
node_modules/.bin/prettier --check .
npx nx typecheck frontend
BLOOM_PORT_OFFSET=0 npx nx test frontend
npx nx build frontend
just e2e        # full Playwright suite against the :8001 replay backend
```

Expected: all green. If prettier flags files: `node_modules/.bin/prettier --write <files>`, re-check, amend nothing — make a `style:` commit if needed.

- [ ] **Step 6: Push + PR**

```bash
git push -u origin feat/param-sidebar-2
gh pr create --title "feat(math): resizable param sidebar, shared shell, semantic groups" --body "<summary of spec + gates run>"
```

---

## Self-Review Notes

- Spec coverage: resizable (T1+T3), reusable shell (T1), regroup (T2), hierarchy (T3), testing section (T1–T4), testid preservation (T3 keeps `advanced-*`/`param-*`; e2e test 6 unchanged), legacy localStorage migration (T1 hook + T3 MathPane restore test).
- Type consistency: `IPaneSidebarState`/`IPaneSidebarProps`/`IPaneSidebarToggleProps` used identically in T1 and T3; group ids `search|genetics|weights|verification|pool|repro` identical in T2 and T3.
- Mid-branch red window: after T2, `ParamSidebar.spec.tsx` is red until T3 — T2's gate is scoped to `paramFields.spec.ts` deliberately; T3 Step 5 runs the full suite.

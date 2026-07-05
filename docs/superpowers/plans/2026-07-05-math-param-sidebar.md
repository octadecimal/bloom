# Math Param Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Math pane's cramped bottom "Advanced" strip with a first-class, toggle-able right sidebar where all 18 tuner/curation params get rich hover tooltips, validation, formatting, steppers, and per-group reset.

**Architecture:** A new token-styled `tooltip.tsx` ui primitive wraps `@radix-ui/react-tooltip`. All params are declared in one `paramFields.ts` registry (label, tooltip copy, unit, min/max/step, backend-mirrored default, slice accessors); a single `ParamField` renders every row; `ParamSidebar` maps the registry grouped by section. `MathPane` gains a header toggle (localStorage-persisted) and a flex-row body; `AdvancedSection.tsx` is deleted. Frontend-only — edits land in the hookstate slice and persist through the existing PUT-before-Generate/Verify flow in `actions.ts`, unchanged.

**Tech Stack:** React 18 + TypeScript, hookstate, Tailwind v4 tokens (design language), Radix UI, lucide-react icons, vitest + @testing-library/react, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-07-05-math-param-sidebar-design.md`

## Global Constraints

- Work in the worktree `C:\code\bloom.wt\math-param-sidebar` (branch `feat/math-param-sidebar`, `BLOOM_PORT_OFFSET=1` → backend :8001, frontend :4201). Never touch the primary checkout.
- TypeScript interfaces use an `I` prefix (`IParamFieldDef`) — `docs/coding-standards.md`.
- No raw colors — only design-language token utilities (`bg-raised`, `border-hairline`, `text-text-1/2/3`, `text-danger`, `ring-ring`, `hover:bg-raised-hover`, `text-accent-text`). The guard spec `design-language.guard.spec.ts` fails the build on any hex/rgba literal outside `styles.css`.
- Semantic commit messages (`feat(math): …`, `test(math): …`).
- Keep existing testids working: `advanced-toggle`, `advanced-params`, `param-master-seed`, `param-pool-size`.
- Defaults mirror `default_tuning_params()` / `default_params()` in `studio/backend/app/math/models.py` — do not invent values.
- Gates before PR (repo root of the worktree): `node_modules/.bin/prettier --check .` (pinned — never `npx prettier` in a fresh worktree), `npx nx typecheck frontend`, `npx nx test frontend`, `npx nx build frontend`, then `just e2e` against a replay backend.

---

### Task 1: Tooltip ui primitive

**Files:**

- Create: `studio/frontend/src/components/ui/tooltip.tsx`
- Test: `studio/frontend/src/components/ui/tooltip.spec.tsx`
- Modify: `package.json` (repo root — new dependency, via npm CLI)

**Interfaces:**

- Consumes: `@radix-ui/react-tooltip` (new dep), `cn` from `@/lib/utils`.
- Produces: `TooltipProvider` (re-export of Radix Provider — callers set `delayDuration`), `Tooltip` (Root), `TooltipTrigger`, `TooltipContent` (portal + token styling, props `ITooltipContentProps`). Later tasks import from `'../../../components/ui/tooltip'`.

- [ ] **Step 1: Bootstrap the worktree and add the dependency**

```bash
cd C:\code\bloom.wt\math-param-sidebar
npm install
npm install @radix-ui/react-tooltip
```

Expected: `@radix-ui/react-tooltip` appears in the root `package.json` dependencies (the repo is a single root package — see `@radix-ui/react-dialog` already there).

- [ ] **Step 2: Write the failing test**

Create `studio/frontend/src/components/ui/tooltip.spec.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from './tooltip';

function Fixture() {
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button>seed</button>
        </TooltipTrigger>
        <TooltipContent>Seeds the RNG</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

describe('Tooltip', () => {
  it('is closed by default', () => {
    render(<Fixture />);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opens on keyboard focus and renders the content', async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    await user.tab(); // focus-visible on the trigger
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toContain('Seeds the RNG');
  });

  it('opens on hover', async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    await user.hover(screen.getByRole('button'));
    expect(await screen.findByRole('tooltip')).toBeTruthy();
  });
});
```

Note: user-event v14 dispatches real pointer events, which Radix needs — do NOT swap `user.hover` for `fireEvent.mouseOver` (it will not open).

- [ ] **Step 3: Run test to verify it fails**

Run: `npx nx test frontend -- src/components/ui/tooltip.spec.tsx`
Expected: FAIL — cannot resolve `./tooltip`.

- [ ] **Step 4: Write the implementation**

Create `studio/frontend/src/components/ui/tooltip.tsx` (mirrors the `dialog.tsx` wrapper style):

```tsx
import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '@/lib/utils';

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

export interface ITooltipContentProps extends React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> {}

const TooltipContent = React.forwardRef<React.ComponentRef<typeof TooltipPrimitive.Content>, ITooltipContentProps>(
  ({ className, sideOffset = 6, ...props }, ref) => (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn('z-50 max-w-64 rounded-md border border-hairline bg-raised px-3 py-2 text-xs leading-relaxed text-text-2 shadow-lg', className)}
        {...props}
      />
    </TooltipPrimitive.Portal>
  ),
);
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx nx test frontend -- src/components/ui/tooltip.spec.tsx`
Expected: 3 PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json studio/frontend/src/components/ui/tooltip.tsx studio/frontend/src/components/ui/tooltip.spec.tsx
git commit -m "feat(ui): token-styled tooltip primitive over @radix-ui/react-tooltip"
```

---

### Task 2: Param field registry

**Files:**

- Create: `studio/frontend/src/plugins/math/components/paramFields.ts`
- Test: `studio/frontend/src/plugins/math/components/paramFields.spec.ts`

**Interfaces:**

- Consumes: `State<IMathState>` from `@hookstate/core` + `../state` (`ITuningParams`, `ICurationParams` shapes; fields accessed via `s.tunerParams.ornull` / `s.curationParams.ornull`).
- Produces (used by Tasks 3–4):
  - `type IParamGroup = 'tuner' | 'weights' | 'curation'`
  - `interface IParamTooltip { title: string; body: string; effect: string }`
  - `interface IParamFieldDef { key: string; label: string; group: IParamGroup; tooltip: IParamTooltip; unit?: string; min?: number; max?: number; step: number; integer: boolean; defaultValue: number; get(s: State<IMathState>): number | null; set(s: State<IMathState>, v: number): void }`
  - `const PARAM_FIELDS: IParamFieldDef[]` (18 entries, keys below)
  - `const PARAM_GROUPS: { id: IParamGroup; label: string }[]`
  - `function resetGroup(s: State<IMathState>, group: IParamGroup): void`

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/plugins/math/components/paramFields.spec.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { PARAM_FIELDS, PARAM_GROUPS, resetGroup } from './paramFields';
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
  rootStore.plugins.nested(MATH_PLUGIN_ID).set(makeInitialState() as never);
});

describe('paramFields registry', () => {
  it('covers all 18 wire fields with unique keys and preserves the legacy testid keys', () => {
    const keys = PARAM_FIELDS.map((f) => f.key);
    expect(keys).toHaveLength(18);
    expect(new Set(keys).size).toBe(18);
    expect(keys).toContain('master-seed'); // legacy testid param-master-seed
    expect(keys).toContain('pool-size'); // legacy testid param-pool-size
  });

  it('has three groups, each non-empty', () => {
    expect(PARAM_GROUPS.map((g) => g.id)).toEqual(['tuner', 'weights', 'curation']);
    for (const g of PARAM_GROUPS) {
      expect(PARAM_FIELDS.some((f) => f.group === g.id)).toBe(true);
    }
  });

  it('defaults mirror studio/backend/app/math/models.py', () => {
    const byKey = Object.fromEntries(PARAM_FIELDS.map((f) => [f.key, f.defaultValue]));
    expect(byKey).toMatchObject({
      'master-seed': 2026,
      population: 24,
      generations: 40,
      'search-spins': 20000,
      'final-spins': 200000,
      elitism: 2,
      mutation: 0.25,
      crossover: 0.9,
      stagnation: 12,
      'weight-rtp': 1.0,
      'weight-volatility': 1.0,
      'weight-hit-rate': 1.0,
      'pool-size': 1000,
      candidates: 50000,
      'sim-seed': 2026,
      'rtp-tolerance': 0.01,
      'correction-band': 0.05,
      'bonus-tolerance': 0.25,
    });
  });

  it('every field carries complete tooltip copy and a positive step', () => {
    for (const f of PARAM_FIELDS) {
      expect(f.tooltip.title.length, f.key).toBeGreaterThan(0);
      expect(f.tooltip.body.length, f.key).toBeGreaterThan(10);
      expect(f.tooltip.effect.length, f.key).toBeGreaterThan(10);
      expect(f.step, f.key).toBeGreaterThan(0);
    }
  });

  it('get returns null before params load, and get/set round-trip through the slice', () => {
    const s = mathSlice();
    for (const f of PARAM_FIELDS) expect(f.get(s), f.key).toBeNull();
    s.tunerParams.set({ ...tunerParams, weights: { ...tunerParams.weights } });
    s.curationParams.set({ ...curationParams });
    for (const f of PARAM_FIELDS) {
      const v = f.integer ? f.defaultValue + 1 : f.defaultValue + 0.01;
      f.set(s, v);
      expect(f.get(s), f.key).toBeCloseTo(v, 10);
    }
  });

  it('resetGroup restores only its own group', () => {
    const s = mathSlice();
    s.tunerParams.set({ ...tunerParams, population: 99, weights: { ...tunerParams.weights, rtp: 9 } });
    s.curationParams.set({ ...curationParams, poolSize: 77 });
    resetGroup(s, 'tuner');
    expect(s.tunerParams.get()?.population).toBe(24);
    expect(s.tunerParams.get()?.weights.rtp).toBe(9); // weights is its own group
    expect(s.curationParams.get()?.poolSize).toBe(77); // curation untouched
    resetGroup(s, 'curation');
    expect(s.curationParams.get()?.poolSize).toBe(1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx nx test frontend -- src/plugins/math/components/paramFields.spec.ts`
Expected: FAIL — cannot resolve `./paramFields`.

- [ ] **Step 3: Write the implementation**

Create `studio/frontend/src/plugins/math/components/paramFields.ts`:

```ts
import type { State } from '@hookstate/core';
import type { IMathState } from '../state';

export type IParamGroup = 'tuner' | 'weights' | 'curation';

export interface IParamTooltip {
  title: string;
  /** 1–2 sentences: what the field IS. */
  body: string;
  /** One line: the practical effect of raising/lowering it. */
  effect: string;
}

export interface IParamFieldDef {
  /** Stable id — also the testid suffix (`param-<key>`). 'master-seed' and
   * 'pool-size' keep the legacy testids alive. */
  key: string;
  label: string;
  group: IParamGroup;
  tooltip: IParamTooltip;
  /** Faint in-field suffix (counts only; fractions are explained in the tooltip). */
  unit?: string;
  min?: number;
  max?: number;
  step: number;
  integer: boolean;
  /** Mirrors default_tuning_params() / default_params() in
   * studio/backend/app/math/models.py — keep in lockstep. */
  defaultValue: number;
  get: (s: State<IMathState>) => number | null;
  set: (s: State<IMathState>, v: number) => void;
}

export const PARAM_GROUPS: { id: IParamGroup; label: string }[] = [
  { id: 'tuner', label: 'Tuner' },
  { id: 'weights', label: 'Fitness weights' },
  { id: 'curation', label: 'Curation' },
];

export const PARAM_FIELDS: IParamFieldDef[] = [
  // ── tuner ──────────────────────────────────────────────────────────────
  {
    key: 'master-seed',
    label: 'Seed',
    group: 'tuner',
    tooltip: {
      title: 'Master seed',
      body: "Seeds the genetic algorithm's random number generator.",
      effect: 'Same seed + same params → an identical, reproducible run.',
    },
    step: 1,
    integer: true,
    defaultValue: 2026,
    get: (s) => s.tunerParams.ornull?.masterSeed.get() ?? null,
    set: (s, v) => s.tunerParams.ornull?.masterSeed.set(v),
  },
  {
    key: 'population',
    label: 'Population',
    group: 'tuner',
    tooltip: {
      title: 'Population',
      body: 'Number of candidate models alive in each GA generation.',
      effect: 'Higher = broader search per generation, but slower.',
    },
    min: 2,
    step: 1,
    integer: true,
    defaultValue: 24,
    get: (s) => s.tunerParams.ornull?.population.get() ?? null,
    set: (s, v) => s.tunerParams.ornull?.population.set(v),
  },
  {
    key: 'generations',
    label: 'Generations',
    group: 'tuner',
    tooltip: {
      title: 'Max generations',
      body: 'Upper budget on GA generations; the run stops earlier once the target is feasible or progress stagnates.',
      effect: 'Higher = more time to converge on hard targets.',
    },
    min: 1,
    step: 1,
    integer: true,
    defaultValue: 40,
    get: (s) => s.tunerParams.ornull?.maxGenerations.get() ?? null,
    set: (s, v) => s.tunerParams.ornull?.maxGenerations.set(v),
  },
  {
    key: 'search-spins',
    label: 'Search spins',
    group: 'tuner',
    tooltip: {
      title: 'Search spins',
      body: 'Spins simulated to measure each candidate during the search phase (low fidelity).',
      effect: 'Higher = less measurement noise, slower generations.',
    },
    unit: 'spins',
    min: 1000,
    step: 1000,
    integer: true,
    defaultValue: 20000,
    get: (s) => s.tunerParams.ornull?.searchCandidateCount.get() ?? null,
    set: (s, v) => s.tunerParams.ornull?.searchCandidateCount.set(v),
  },
  {
    key: 'final-spins',
    label: 'Final spins',
    group: 'tuner',
    tooltip: {
      title: 'Final spins',
      body: 'Spins for the trusted final-fidelity confirmation of the best candidate; only these measurements decide the verdict.',
      effect: 'Higher = tighter confidence in the reported metrics.',
    },
    unit: 'spins',
    min: 10000,
    step: 10000,
    integer: true,
    defaultValue: 200000,
    get: (s) => s.tunerParams.ornull?.finalCandidateCount.get() ?? null,
    set: (s, v) => s.tunerParams.ornull?.finalCandidateCount.set(v),
  },
  {
    key: 'elitism',
    label: 'Elitism',
    group: 'tuner',
    tooltip: {
      title: 'Elitism',
      body: 'Best candidates copied unchanged into the next generation.',
      effect: 'Guards against losing the best solution to mutation.',
    },
    min: 0,
    step: 1,
    integer: true,
    defaultValue: 2,
    get: (s) => s.tunerParams.ornull?.elitism.get() ?? null,
    set: (s, v) => s.tunerParams.ornull?.elitism.set(v),
  },
  {
    key: 'mutation',
    label: 'Mutation',
    group: 'tuner',
    tooltip: {
      title: 'Mutation rate',
      body: 'Chance each gene mutates while breeding the next generation (0–1).',
      effect: 'Higher = more exploration, less stability.',
    },
    min: 0,
    max: 1,
    step: 0.05,
    integer: false,
    defaultValue: 0.25,
    get: (s) => s.tunerParams.ornull?.mutationRate.get() ?? null,
    set: (s, v) => s.tunerParams.ornull?.mutationRate.set(v),
  },
  {
    key: 'crossover',
    label: 'Crossover',
    group: 'tuner',
    tooltip: {
      title: 'Crossover rate',
      body: 'Chance two parents mix genes instead of cloning (0–1).',
      effect: 'Higher = more recombination of good traits.',
    },
    min: 0,
    max: 1,
    step: 0.05,
    integer: false,
    defaultValue: 0.9,
    get: (s) => s.tunerParams.ornull?.crossoverRate.get() ?? null,
    set: (s, v) => s.tunerParams.ornull?.crossoverRate.set(v),
  },
  {
    key: 'stagnation',
    label: 'Stagnation',
    group: 'tuner',
    tooltip: {
      title: 'Stagnation window',
      body: 'Generations without improvement before the GA stops early.',
      effect: 'Lower = give up sooner on a stuck search.',
    },
    unit: 'gens',
    min: 1,
    step: 1,
    integer: true,
    defaultValue: 12,
    get: (s) => s.tunerParams.ornull?.stagnationWindow.get() ?? null,
    set: (s, v) => s.tunerParams.ornull?.stagnationWindow.set(v),
  },
  // ── fitness weights ────────────────────────────────────────────────────
  {
    key: 'weight-rtp',
    label: 'RTP',
    group: 'weights',
    tooltip: {
      title: 'RTP weight',
      body: 'Relative importance of RTP error in the fitness score.',
      effect: 'Higher = the GA prioritizes matching RTP.',
    },
    min: 0,
    step: 0.1,
    integer: false,
    defaultValue: 1.0,
    get: (s) => s.tunerParams.ornull?.weights.rtp.get() ?? null,
    set: (s, v) => s.tunerParams.ornull?.weights.rtp.set(v),
  },
  {
    key: 'weight-volatility',
    label: 'Volatility',
    group: 'weights',
    tooltip: {
      title: 'Volatility weight',
      body: 'Relative importance of volatility error in the fitness score.',
      effect: 'Higher = the GA prioritizes matching volatility.',
    },
    min: 0,
    step: 0.1,
    integer: false,
    defaultValue: 1.0,
    get: (s) => s.tunerParams.ornull?.weights.volatility.get() ?? null,
    set: (s, v) => s.tunerParams.ornull?.weights.volatility.set(v),
  },
  {
    key: 'weight-hit-rate',
    label: 'Hit rate',
    group: 'weights',
    tooltip: {
      title: 'Hit-rate weight',
      body: 'Relative importance of bonus hit-rate error in the fitness score.',
      effect: 'Higher = the GA prioritizes matching bonus hit rates.',
    },
    min: 0,
    step: 0.1,
    integer: false,
    defaultValue: 1.0,
    get: (s) => s.tunerParams.ornull?.weights.hitRate.get() ?? null,
    set: (s, v) => s.tunerParams.ornull?.weights.hitRate.set(v),
  },
  // ── curation ───────────────────────────────────────────────────────────
  {
    key: 'pool-size',
    label: 'Pool size',
    group: 'curation',
    tooltip: {
      title: 'Pool size',
      body: 'Outcomes frozen into the signed pool the game server draws from.',
      effect: "Larger pools track the model's RTP more faithfully.",
    },
    unit: 'outcomes',
    min: 100,
    step: 100,
    integer: true,
    defaultValue: 1000,
    get: (s) => s.curationParams.ornull?.poolSize.get() ?? null,
    set: (s, v) => s.curationParams.ornull?.poolSize.set(v),
  },
  {
    key: 'candidates',
    label: 'Candidates',
    group: 'curation',
    tooltip: {
      title: 'Candidates',
      body: 'Spins simulated to measure the model during verification.',
      effect: 'Higher = less measurement noise, slower verify.',
    },
    unit: 'spins',
    min: 1000,
    step: 1000,
    integer: true,
    defaultValue: 50000,
    get: (s) => s.curationParams.ornull?.candidateCount.get() ?? null,
    set: (s, v) => s.curationParams.ornull?.candidateCount.set(v),
  },
  {
    key: 'sim-seed',
    label: 'Sim seed',
    group: 'curation',
    tooltip: {
      title: 'Sim seed',
      body: "Seeds the verification simulation's random number generator.",
      effect: 'Same seed + same model → identical verification.',
    },
    step: 1,
    integer: true,
    defaultValue: 2026,
    get: (s) => s.curationParams.ornull?.masterSeed.get() ?? null,
    set: (s, v) => s.curationParams.ornull?.masterSeed.set(v),
  },
  {
    key: 'rtp-tolerance',
    label: 'RTP tolerance',
    group: 'curation',
    tooltip: {
      title: 'RTP tolerance',
      body: 'Allowed absolute deviation of measured RTP from the target (0.01 = ±1%).',
      effect: 'Tighter = stricter pass, more verify failures.',
    },
    min: 0.001,
    step: 0.005,
    integer: false,
    defaultValue: 0.01,
    get: (s) => s.curationParams.ornull?.rtpTolerance.get() ?? null,
    set: (s, v) => s.curationParams.ornull?.rtpTolerance.set(v),
  },
  {
    key: 'correction-band',
    label: 'Correction band',
    group: 'curation',
    tooltip: {
      title: 'Correction band',
      body: "Honesty guardrail: curation may only correct the pool toward a target within this band of the model's measured RTP.",
      effect: 'Outside the band, curation fails instead of lying.',
    },
    min: 0.001,
    step: 0.01,
    integer: false,
    defaultValue: 0.05,
    get: (s) => s.curationParams.ornull?.realizedCorrectionBand.get() ?? null,
    set: (s, v) => s.curationParams.ornull?.realizedCorrectionBand.set(v),
  },
  {
    key: 'bonus-tolerance',
    label: 'Bonus tolerance',
    group: 'curation',
    tooltip: {
      title: 'Bonus tolerance',
      body: 'Relative ± band around the GDD bonus hit rate during verification.',
      effect: 'Tighter = bonus rates must match the design more exactly.',
    },
    min: 0.01,
    step: 0.05,
    integer: false,
    defaultValue: 0.25,
    get: (s) => s.curationParams.ornull?.bonusRateTolerance.get() ?? null,
    set: (s, v) => s.curationParams.ornull?.bonusRateTolerance.set(v),
  },
];

/** Write a group's backend defaults into the slice; a no-op while that group's
 * params haven't loaded (accessors guard with `ornull`). */
export function resetGroup(s: State<IMathState>, group: IParamGroup): void {
  for (const f of PARAM_FIELDS) if (f.group === group) f.set(s, f.defaultValue);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx nx test frontend -- src/plugins/math/components/paramFields.spec.ts`
Expected: 6 PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/math/components/paramFields.ts studio/frontend/src/plugins/math/components/paramFields.spec.ts
git commit -m "feat(math): param field registry with tooltip copy, bounds and backend-mirrored defaults"
```

---

### Task 3: ParamField component

**Files:**

- Create: `studio/frontend/src/plugins/math/components/ParamField.tsx`
- Test: `studio/frontend/src/plugins/math/components/ParamField.spec.tsx`

**Interfaces:**

- Consumes: `IParamFieldDef` + `PARAM_FIELDS` (Task 2), `Tooltip`/`TooltipTrigger`/`TooltipContent` (Task 1), `mathHooks`/`mathSlice` from `../state`. Callers MUST wrap in a `TooltipProvider` (Task 4 does).
- Produces: `function ParamField({ def }: { def: IParamFieldDef })` — renders `null` until the def's params load. Also exports pure helpers `clampToDef(v, def): number` and `formatValue(v, def): string`. Testids: input `param-<key>`, steppers `param-<key>-up` / `param-<key>-down`; wrapper carries `data-invalid="true"` while the draft is invalid.

Behavior contract (from the spec):

- Valid-as-typed values land in the slice immediately (today's behavior). Non-numeric or out-of-range input shows a `--danger` border and does NOT touch the slice.
- Blur: numeric drafts are clamped to min/max (and rounded when `integer`) and committed; garbage reverts to the slice value.
- Unfocused display: integer values ≥ 1000 render with thousands separators; focusing swaps to the raw editable number.
- Steppers (and ArrowUp/ArrowDown) step by `def.step`, clamped.

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/plugins/math/components/ParamField.spec.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TooltipProvider } from '../../../components/ui/tooltip';
import { ParamField, clampToDef, formatValue } from './ParamField';
import { PARAM_FIELDS } from './paramFields';
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

const def = (key: string) => {
  const d = PARAM_FIELDS.find((f) => f.key === key);
  if (!d) throw new Error(`no def ${key}`);
  return d;
};

function renderField(key: string) {
  return render(
    <TooltipProvider delayDuration={0}>
      <ParamField def={def(key)} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  rootStore.plugins.nested(MATH_PLUGIN_ID).set(makeInitialState() as never);
  mathSlice().tunerParams.set({ ...tunerParams, weights: { ...tunerParams.weights } });
});

describe('ParamField', () => {
  it('renders nothing until its params load', () => {
    mathSlice().tunerParams.set(null);
    renderField('population');
    expect(screen.queryByTestId('param-population')).toBeNull();
  });

  it('writes a valid typed value straight into the slice', () => {
    renderField('master-seed');
    fireEvent.change(screen.getByTestId('param-master-seed'), { target: { value: '777' } });
    expect(mathSlice().tunerParams.get()?.masterSeed).toBe(777);
  });

  it('marks out-of-range input invalid without touching the slice, then clamps on blur', () => {
    renderField('population'); // min 2
    const input = screen.getByTestId('param-population');
    fireEvent.change(input, { target: { value: '0' } });
    expect(mathSlice().tunerParams.get()?.population).toBe(24); // unchanged
    expect(screen.getByTestId('param-population-wrap').getAttribute('data-invalid')).toBe('true');
    fireEvent.blur(input);
    expect(mathSlice().tunerParams.get()?.population).toBe(2); // clamped
    expect(screen.getByTestId('param-population-wrap').getAttribute('data-invalid')).toBeNull();
  });

  it('reverts non-numeric garbage on blur', () => {
    renderField('population');
    const input = screen.getByTestId('param-population');
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(mathSlice().tunerParams.get()?.population).toBe(24);
    fireEvent.blur(input);
    expect(mathSlice().tunerParams.get()?.population).toBe(24);
    expect((input as HTMLInputElement).value).toBe('24');
  });

  it('formats large integers with separators when unfocused, raw when focused', () => {
    renderField('final-spins');
    const input = screen.getByTestId('param-final-spins') as HTMLInputElement;
    expect(input.value).toBe('200,000');
    fireEvent.focus(input);
    expect(input.value).toBe('200000');
    fireEvent.blur(input);
    expect(input.value).toBe('200,000');
  });

  it('steppers step by def.step and clamp; float steps stay clean', () => {
    renderField('mutation'); // 0.25, step 0.05, max 1
    fireEvent.click(screen.getByTestId('param-mutation-up'));
    expect(mathSlice().tunerParams.get()?.mutationRate).toBe(0.3);
    fireEvent.click(screen.getByTestId('param-mutation-down'));
    fireEvent.click(screen.getByTestId('param-mutation-down'));
    expect(mathSlice().tunerParams.get()?.mutationRate).toBe(0.2);
  });

  it('ArrowUp on the input steps too', () => {
    renderField('elitism');
    fireEvent.keyDown(screen.getByTestId('param-elitism'), { key: 'ArrowUp' });
    expect(mathSlice().tunerParams.get()?.elitism).toBe(3);
  });

  it('clampToDef and formatValue behave', () => {
    expect(clampToDef(0.5, def('population'))).toBe(2); // rounds then clamps... rounds 0.5→1 (banker-free Math.round), clamps to 2
    expect(clampToDef(7.4, def('elitism'))).toBe(7);
    expect(clampToDef(2, def('mutation'))).toBe(1); // max 1
    expect(formatValue(20000, def('search-spins'))).toBe('20,000');
    expect(formatValue(0.25, def('mutation'))).toBe('0.25');
    expect(formatValue(999, def('elitism'))).toBe('999');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx nx test frontend -- src/plugins/math/components/ParamField.spec.tsx`
Expected: FAIL — cannot resolve `./ParamField`.

- [ ] **Step 3: Write the implementation**

Create `studio/frontend/src/plugins/math/components/ParamField.tsx`:

```tsx
import { useState } from 'react';
import { ChevronDown, ChevronUp, Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import { mathHooks, mathSlice } from '../state';
import type { IParamFieldDef } from './paramFields';

export function clampToDef(v: number, def: IParamFieldDef): number {
  let x = def.integer ? Math.round(v) : v;
  if (def.min !== undefined && x < def.min) x = def.min;
  if (def.max !== undefined && x > def.max) x = def.max;
  return x;
}

export function formatValue(v: number, def: IParamFieldDef): string {
  return def.integer && Math.abs(v) >= 1000 ? v.toLocaleString('en-US') : String(v);
}

function inRange(v: number, def: IParamFieldDef): boolean {
  return Number.isFinite(v) && (def.min === undefined || v >= def.min) && (def.max === undefined || v <= def.max);
}

const parse = (raw: string): number => (raw.trim() === '' ? NaN : Number(raw));

/** One registry-driven param row: tooltip'd label + validated number input with
 * design-language steppers. Must render inside a TooltipProvider. */
export function ParamField({ def }: { def: IParamFieldDef }) {
  const s = mathHooks.usePluginState();
  // Raw text while the user is editing; null = not editing (show formatted slice value).
  const [draft, setDraft] = useState<string | null>(null);
  const value = def.get(s);
  if (value === null) return null;

  const invalid = draft !== null && !inRange(parse(draft), def);
  const commit = (v: number) => def.set(mathSlice(), clampToDef(v, def));

  const step = (dir: 1 | -1) => {
    setDraft(null);
    // toFixed dodges float drift (0.25 + 0.05 → 0.30000000000000004).
    commit(Number((value + dir * def.step).toFixed(6)));
  };

  return (
    <label className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="flex w-24 flex-none cursor-help items-center gap-1 text-[10px] uppercase tracking-wide text-text-2 outline-none focus-visible:text-text-1"
          >
            <span className="truncate">{def.label}</span>
            <Info className="h-3 w-3 flex-none text-text-3" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="left">
          <div className="text-text-1">{def.tooltip.title}</div>
          <div className="mt-1">{def.tooltip.body}</div>
          <div className="mt-1">{def.tooltip.effect}</div>
          <div className="mt-1 text-text-3">
            Default: {formatValue(def.defaultValue, def)}
            {def.unit ? ` ${def.unit}` : ''}
          </div>
        </TooltipContent>
      </Tooltip>
      <div
        data-testid={`param-${def.key}-wrap`}
        data-invalid={invalid || undefined}
        className={`flex h-7 min-w-0 flex-1 items-center overflow-hidden rounded border bg-raised focus-within:ring-2 focus-within:ring-ring ${invalid ? 'border-danger' : 'border-hairline'}`}
      >
        <input
          data-testid={`param-${def.key}`}
          type="text"
          inputMode="decimal"
          value={draft ?? formatValue(value, def)}
          onFocus={() => setDraft(String(value))}
          onChange={(e) => {
            setDraft(e.target.value);
            const n = parse(e.target.value);
            if (inRange(n, def)) def.set(mathSlice(), def.integer ? Math.round(n) : n);
          }}
          onBlur={() => {
            if (draft !== null && Number.isFinite(parse(draft))) commit(parse(draft));
            setDraft(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') (e.preventDefault(), step(1));
            if (e.key === 'ArrowDown') (e.preventDefault(), step(-1));
          }}
          className="w-full min-w-0 bg-transparent px-2 text-[13px] text-text-1 outline-none"
        />
        {def.unit && <span className="flex-none pr-1.5 text-[10px] text-text-3">{def.unit}</span>}
        <div className="flex h-full flex-none flex-col border-l border-hairline">
          <button
            type="button"
            data-testid={`param-${def.key}-up`}
            tabIndex={-1}
            aria-label={`increase ${def.label}`}
            onClick={() => step(1)}
            className="flex h-1/2 w-5 items-center justify-center text-text-3 hover:bg-raised-hover hover:text-text-1"
          >
            <ChevronUp className="h-3 w-3" />
          </button>
          <button
            type="button"
            data-testid={`param-${def.key}-down`}
            tabIndex={-1}
            aria-label={`decrease ${def.label}`}
            onClick={() => step(-1)}
            className="flex h-1/2 w-5 items-center justify-center border-t border-hairline text-text-3 hover:bg-raised-hover hover:text-text-1"
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </div>
      </div>
    </label>
  );
}
```

Notes for the implementer:

- `type="text"` + `inputMode="decimal"` is deliberate: it lets the unfocused value show `200,000` (invalid in a `type=number` input) and there are no native spinners to hide — our chevrons are the only steppers.
- The label `<span tabIndex={0}>` makes the tooltip keyboard-reachable (Radix opens on focus-visible).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx nx test frontend -- src/plugins/math/components/ParamField.spec.tsx`
Expected: 8 PASS. If the `clampToDef(0.5, population)` assertion surprises you: `Math.round(0.5) = 1`, then min 2 clamps to 2 — the test expects 2.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/math/components/ParamField.tsx studio/frontend/src/plugins/math/components/ParamField.spec.tsx
git commit -m "feat(math): ParamField row — tooltip'd label, validated input, chevron steppers"
```

---

### Task 4: ParamSidebar + visibility hook

**Files:**

- Create: `studio/frontend/src/plugins/math/components/ParamSidebar.tsx`
- Test: `studio/frontend/src/plugins/math/components/ParamSidebar.spec.tsx`

**Interfaces:**

- Consumes: `PARAM_FIELDS`, `PARAM_GROUPS`, `resetGroup` (Task 2), `ParamField` (Task 3), `TooltipProvider` (Task 1), `mathSlice` from `../state`.
- Produces (used by Task 5):
  - `function ParamSidebar()` — the full right column, testid `advanced-params`; group reset buttons `param-reset-tuner` / `param-reset-weights` / `param-reset-curation`.
  - `function useParamSidebarOpen(): [boolean, () => void]` — localStorage-backed (`bloom.math.sidebar`, `'1'`/`'0'`, default closed).

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/plugins/math/components/ParamSidebar.spec.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ParamSidebar, useParamSidebarOpen } from './ParamSidebar';
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

function Harness() {
  const [open, toggle] = useParamSidebarOpen();
  return <button data-testid="harness-toggle" aria-pressed={open} onClick={toggle} />;
}

beforeEach(() => {
  localStorage.clear();
  rootStore.plugins.nested(MATH_PLUGIN_ID).set(makeInitialState() as never);
  mathSlice().tunerParams.set({ ...tunerParams, weights: { ...tunerParams.weights } });
  mathSlice().curationParams.set({ ...curationParams });
});

describe('ParamSidebar', () => {
  it('renders all three groups with their fields', () => {
    render(<ParamSidebar />);
    expect(screen.getByTestId('advanced-params')).toBeTruthy();
    expect(screen.getByText('Tuner')).toBeTruthy();
    expect(screen.getByText('Fitness weights')).toBeTruthy();
    expect(screen.getByText('Curation')).toBeTruthy();
    expect(screen.getByTestId('param-master-seed')).toBeTruthy();
    expect(screen.getByTestId('param-crossover')).toBeTruthy();
    expect(screen.getByTestId('param-weight-rtp')).toBeTruthy();
    expect(screen.getByTestId('param-pool-size')).toBeTruthy();
  });

  it('group reset restores only its own group', () => {
    render(<ParamSidebar />);
    fireEvent.change(screen.getByTestId('param-population'), { target: { value: '50' } });
    fireEvent.change(screen.getByTestId('param-pool-size'), { target: { value: '700' } });
    fireEvent.click(screen.getByTestId('param-reset-tuner'));
    expect(mathSlice().tunerParams.get()?.population).toBe(24);
    expect(mathSlice().curationParams.get()?.poolSize).toBe(700);
  });
});

describe('useParamSidebarOpen', () => {
  it('defaults closed and persists a toggle to localStorage', () => {
    render(<Harness />);
    const btn = screen.getByTestId('harness-toggle');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem('bloom.math.sidebar')).toBe('1');
  });

  it('restores a persisted open state', () => {
    localStorage.setItem('bloom.math.sidebar', '1');
    render(<Harness />);
    expect(screen.getByTestId('harness-toggle').getAttribute('aria-pressed')).toBe('true');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx nx test frontend -- src/plugins/math/components/ParamSidebar.spec.tsx`
Expected: FAIL — cannot resolve `./ParamSidebar`.

- [ ] **Step 3: Write the implementation**

Create `studio/frontend/src/plugins/math/components/ParamSidebar.tsx`:

```tsx
import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { TooltipProvider } from '../../../components/ui/tooltip';
import { mathSlice } from '../state';
import { PARAM_FIELDS, PARAM_GROUPS, resetGroup } from './paramFields';
import { ParamField } from './ParamField';

const STORAGE_KEY = 'bloom.math.sidebar';

/** Sidebar visibility, persisted per user (UI preference, not game data). */
export function useParamSidebarOpen(): [boolean, () => void] {
  const [open, setOpen] = useState(() => localStorage.getItem(STORAGE_KEY) === '1');
  const toggle = () =>
    setOpen((v) => {
      const next = !v;
      localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      return next;
    });
  return [open, toggle];
}

/** The first-class params column (the old AdvancedSection, promoted). Edits
 * land in the slice; they persist via the PUT that precedes every Generate
 * (tuner_params) / Verify (params) — see actions.ts. */
export function ParamSidebar() {
  return (
    <div data-testid="advanced-params" className="w-60 flex-none overflow-y-auto border-l border-hairline p-3">
      <TooltipProvider delayDuration={300}>
        <div className="flex flex-col gap-4">
          {PARAM_GROUPS.map((g) => (
            <section key={g.id}>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wide text-text-2">{g.label}</span>
                <button
                  type="button"
                  data-testid={`param-reset-${g.id}`}
                  title={`Reset ${g.label.toLowerCase()} to defaults`}
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx nx test frontend -- src/plugins/math/components/ParamSidebar.spec.tsx`
Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/math/components/ParamSidebar.tsx studio/frontend/src/plugins/math/components/ParamSidebar.spec.tsx
git commit -m "feat(math): ParamSidebar — grouped registry fields, per-group reset, persisted visibility hook"
```

---

### Task 5: MathPane integration; delete AdvancedSection

**Files:**

- Modify: `studio/frontend/src/plugins/math/MathPane.tsx`
- Modify: `studio/frontend/src/plugins/math/MathPane.spec.tsx`
- Delete: `studio/frontend/src/plugins/math/components/AdvancedSection.tsx`, `studio/frontend/src/plugins/math/components/AdvancedSection.spec.tsx`

**Interfaces:**

- Consumes: `ParamSidebar`, `useParamSidebarOpen` (Task 4); `SlidersHorizontal` from `lucide-react`.
- Produces: `advanced-toggle` testid moves to the header icon button (`aria-pressed` reflects state); `advanced-params` is the sidebar. No other testid changes.

- [ ] **Step 1: Write the failing tests**

In `studio/frontend/src/plugins/math/MathPane.spec.tsx`:

(a) Add `localStorage.clear();` as the first line of the existing `beforeEach` callback.

(b) Add a `tunerParams` fixture after the `run()` helper (reuse its shape):

```tsx
const tunerParamsFixture = run('seed-only').params;
```

(c) Rename the existing test `'renders GenerateBar, ResultStrip and AdvancedSection around the tab bar'` to `'renders GenerateBar, ResultStrip and the advanced toggle around the tab bar'` (body unchanged — it asserts `advanced-toggle` exists, which stays true).

(d) Add two tests at the end of the `describe('MathPane', …)` block:

```tsx
it('opens the param sidebar from the header toggle and persists the choice', () => {
  mathSlice().activeGameId.set('g1');
  mathSlice().loadStatus.set('idle');
  mathSlice().tunerParams.set(tunerParamsFixture);
  render(<MathPane {...({} as never)} />);
  expect(screen.queryByTestId('advanced-params')).toBeNull();
  const toggle = screen.getByTestId('advanced-toggle');
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(toggle);
  expect(screen.getByTestId('advanced-params')).toBeTruthy();
  expect(screen.getByTestId('param-master-seed')).toBeTruthy();
  expect(toggle.getAttribute('aria-pressed')).toBe('true');
  expect(localStorage.getItem('bloom.math.sidebar')).toBe('1');
});

it('restores a persisted-open sidebar on mount', () => {
  localStorage.setItem('bloom.math.sidebar', '1');
  mathSlice().activeGameId.set('g1');
  mathSlice().loadStatus.set('idle');
  mathSlice().tunerParams.set(tunerParamsFixture);
  render(<MathPane {...({} as never)} />);
  expect(screen.getByTestId('advanced-params')).toBeTruthy();
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx nx test frontend -- src/plugins/math/MathPane.spec.tsx`
Expected: the two new tests FAIL (sidebar doesn't exist; `advanced-toggle` has no `aria-pressed`); the renamed test still passes.

- [ ] **Step 3: Rework MathPane**

In `studio/frontend/src/plugins/math/MathPane.tsx`:

(a) Replace the `AdvancedSection` import with:

```tsx
import { SlidersHorizontal } from 'lucide-react';
import { ParamSidebar, useParamSidebarOpen } from './components/ParamSidebar';
```

(b) Add the hook alongside the existing `useState` at the top of the component (BEFORE the `if (!activeGameId)` early return — hooks must be unconditional):

```tsx
const [sidebarOpen, toggleSidebar] = useParamSidebarOpen();
```

(c) Replace the header row (currently the `<div className="flex flex-none items-center justify-between border-b border-hairline p-2">…</div>` block) with:

```tsx
<div className="flex flex-none items-center justify-between border-b border-hairline p-2">
  <span className="text-sm text-text-1">Math</span>
  <div className="flex items-center gap-2">
    {run && (
      <span className="text-xs text-text-3">
        {run.verdict === 'pass' ? 'PASS' : run.verdict === 'near_miss' ? 'NEAR-MISS' : ''} · {new Date(run.createdAt).toLocaleString()}
      </span>
    )}
    <button
      type="button"
      data-testid="advanced-toggle"
      aria-pressed={sidebarOpen}
      title="Tuning parameters"
      onClick={toggleSidebar}
      className={`rounded p-1 hover:bg-raised-hover ${sidebarOpen ? 'text-accent-text' : 'text-text-2'}`}
    >
      <SlidersHorizontal className="h-3.5 w-3.5" />
    </button>
  </div>
</div>
```

(d) Wrap everything below the header in a flex row — the left column is the existing stack minus `<AdvancedSection />`, the right is the sidebar:

```tsx
<div className="flex min-h-0 flex-1">
  <div className="flex min-w-0 flex-1 flex-col">
    <TargetStrip />
    <GenerateBar />

    {/* …existing tablist div, unchanged… */}

    {/* …existing content div (className="min-h-0 flex-1"), unchanged… */}

    <ResultStrip />
  </div>
  {sidebarOpen && <ParamSidebar />}
</div>
```

Remove `<AdvancedSection />` and its import entirely.

(e) Delete the old component:

```bash
git rm studio/frontend/src/plugins/math/components/AdvancedSection.tsx studio/frontend/src/plugins/math/components/AdvancedSection.spec.tsx
```

(Nothing else imports it — verify with `grep -rn "AdvancedSection" studio/frontend/src studio/frontend/e2e` → only MathPane before this edit, nothing after.)

- [ ] **Step 4: Run the full frontend unit suite**

Run: `npx nx test frontend`
Expected: all PASS (including the two new MathPane tests and every pre-existing spec).

- [ ] **Step 5: Commit**

```bash
git add -A studio/frontend/src/plugins/math
git commit -m "feat(math): promote Advanced strip to a first-class toggle-able param sidebar"
```

---

### Task 6: E2e coverage + full gates

**Files:**

- Modify: `studio/frontend/e2e/math-plugin.spec.ts` (append one test)

**Interfaces:**

- Consumes: the spec file's existing `setupGame`/`openMath` helpers, `MODEL_09`, `FAST_SIM_PARAMS`, `BACKEND`.

- [ ] **Step 1: Append the e2e test**

At the end of `studio/frontend/e2e/math-plugin.spec.ts`:

```ts
// ---------------------------------------------------------------------------
// Test 6 — param sidebar: toggle, rich tooltip, edited param persists (the
// observable end-state, not the dispatch) through Verify.
// ---------------------------------------------------------------------------

test('param sidebar: tooltip on hover, edited pool size persists through Verify', async ({ page, request }) => {
  test.setTimeout(120_000);

  const gameId = await setupGame(page, request, 'erin', `sidebar ${Date.now()}`, {
    model: MODEL_09,
    simParams: FAST_SIM_PARAMS,
    intent: { rtp: '90%', volatility: 'low' },
  });
  await openMath(page);

  // Toggle the sidebar open from the header icon.
  await page.getByTestId('advanced-toggle').click();
  await expect(page.getByTestId('advanced-params')).toBeVisible();

  // Rich tooltip on label hover.
  await page.getByTestId('advanced-params').getByText('Pool size', { exact: true }).hover();
  await expect(page.getByRole('tooltip')).toContainText('signed pool');

  // Edit a curation param, run Verify, assert the persisted end-state.
  await page.getByTestId('param-pool-size').fill('600');
  await page.getByTestId('verify-button').click();
  await expect(page.getByTestId('result-verdict')).toContainText('PASS', { timeout: 90_000 });

  const after = await request.get(`${BACKEND}/games/${gameId}/slot-model`);
  const doc = (await after.json()) as { params: { poolSize: number } };
  expect(doc.params.poolSize).toBe(600);
});
```

- [ ] **Step 2: Run the e2e spec against a replay backend**

This worktree is `BLOOM_PORT_OFFSET=1` (backend :8001, frontend :4201) — the offset is already in `.env`; NEVER fall back to :8000/:4200 (another live session may hold them).

```bash
cargo build --release -p bloom-simulator -p bloom-tuner
just backend-serve-replay        # leave running (own terminal / background)
npx playwright test --config=studio/frontend/playwright.config.ts math-plugin.spec.ts
```

Expected: all math-plugin tests PASS, including the new Test 6.

- [ ] **Step 3: Run every gate**

From the worktree root:

```bash
node_modules/.bin/prettier --check .
npx nx typecheck frontend
npx nx test frontend
npx nx build frontend
just e2e
```

Expected: all green (vitest green ≠ types valid — typecheck and build are separate, non-skippable gates). If prettier flags files, run `node_modules/.bin/prettier --write <files>` and re-check.

- [ ] **Step 4: Commit**

```bash
git add studio/frontend/e2e/math-plugin.spec.ts
git commit -m "test(math): e2e — param sidebar toggle, tooltip, edited param persists through Verify"
```

---

### Task 7: Finish the branch

- [ ] **Step 1: Push and open a PR** (default flow — no options menu; `main` is protected):

```bash
git push -u origin feat/math-param-sidebar
gh pr create --title "feat(math): first-class param sidebar with rich tooltips" --body "$(cat <<'EOF'
Promotes the Math pane's Advanced strip to a toggle-able right sidebar: all 18
tuner/curation params (incl. the previously hidden elitism/crossover/stagnation/
fitness weights) in three groups, each with a rich hover tooltip, validation
guardrails, units/formatting, per-group reset, and design-language steppers.
New token-styled tooltip primitive over @radix-ui/react-tooltip.

Spec: docs/superpowers/specs/2026-07-05-math-param-sidebar-design.md
Plan: docs/superpowers/plans/2026-07-05-math-param-sidebar.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: After CI is green, hand off to `/bloom:complete-work`** (merges, cleans up the worktree, restarts the live stack — note: the merged PR adds an npm dep, so the primary checkout needs `npm install` during live bring-up).

---

## Self-Review (completed)

- **Spec coverage:** layout/toggle/persistence → Tasks 4–5; tooltip primitive + a11y → Task 1; registry incl. hidden knobs + tooltip copy + defaults lockstep → Task 2; validation/formatting/steppers/reset → Tasks 3–4; testids preserved → Tasks 2/5; e2e → Task 6. The spec's "native spinners hidden via CSS" line is satisfied differently: `type="text"` inputs have no native spinners at all (noted in Task 3) — same outcome, less CSS.
- **Placeholder scan:** none — every step carries full code/commands.
- **Type consistency:** `IParamFieldDef` (key/label/group/tooltip/unit/min/max/step/integer/defaultValue/get/set) is defined once in Task 2 and consumed with those exact names in Tasks 3–4; `useParamSidebarOpen(): [boolean, () => void]` matches its Task 5 usage; testid scheme `param-<key>`(`-up`/`-down`/`-wrap`) is uniform across Tasks 3, 4, 5, 6.

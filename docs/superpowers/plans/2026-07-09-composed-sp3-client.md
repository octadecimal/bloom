# Composed SP3: Client Trace Playback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `runtime/client` plays a `composed@1` package end to end — TS mirror types, a TraceWalker that steps the client through the served lifecycle trace, a MeterModule, definition-driven module instances, play mode against the composed demo `.pkg`, golden-vector parity tests, and Playwright e2e.

**Architecture:** Hand-written TS mirrors of the Rust wire shapes (kernel golden vectors are the drift alarm). A `TraceWalker` beside the existing `Orchestrator` (slots stays on Orchestrator, untouched) dispatches `trigger` trace entries to module instances via an awaited `ITriggerTarget.invoke(trigger, data)` seam resolved by mechanic instance id; all other entries become bus events. Module instances are built from the Game Definition's `mechanics` list; play mode branches on the handshake `mechanic`.

**Tech Stack:** TypeScript, vitest, Playwright; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-09-composed-sp3-client-design.md` (approved). Wire shapes: `docs/superpowers/specs/2026-07-09-composed-sp2-package-server-design.md` §5; live examples `runtime/server/tests/composed.rs`; Rust types `trusted/math/src/mechanics/composed/{definition,trace}.rs`.

## Global Constraints

- **Worktree:** all work happens in `C:\code\bloom.wt\composed-sp3` (branch `feat/composed-sp3`, `BLOOM_PORT_OFFSET=2`). Never the primary checkout. Before Task 1, run `npm install` in the worktree root (per-worktree deps).
- **Ports (offset 2):** runtime client dev server `:4302`, slots e2e server `:9002`, composed e2e server `:9102`. NEVER use the default ports (`:4300`/`:9000`) — another live session may hold them. Export `BLOOM_PORT_OFFSET=2` in the shell before running Playwright.
- **TypeScript interfaces use the `I` prefix** (`ITraceEntry`, `ITriggerTarget`) — `docs/coding-standards.md`.
- **Semantic commits** (`feat(runtime-client): …`, `test: …`) — AGENTS.md.
- **TDD:** every task is RED → GREEN → commit. Run the client unit suite with `npx nx test client` (from the worktree root). It must be fully green after every task.
- **Prettier is pinned:** format with `node_modules/.bin/prettier --write <files>` (never bare `npx prettier` — a fresh worktree pulls a newer version that disagrees).
- **`slots@1` client behavior must not change.** Existing specs stay green untouched (except mechanical type-literal fixes called out in Task 1).
- **Windows gotcha:** a cargo build failing with `os error 4551` on a build-script exe means App Control blocked a stale artifact — delete `target/*/build/<crate>-*` and rebuild.

## File Structure

```
runtime/client/src/play/composedTypes.ts          (new)  mirror types + validateDefinition
runtime/client/src/play/composedTypes.spec.ts     (new)
runtime/client/src/play/wireTypes.ts               (mod)  definition?/trace?/outcome union
runtime/client/src/play/outcomeAdapter.ts          (mod)  narrow the union (behavior identical)
runtime/client/src/play/outcomeAdapter.spec.ts     (mod)  literal-type cast fix only
runtime/client/src/orchestration/traceWalker.ts    (new)  ITriggerTarget + TraceWalker
runtime/client/src/orchestration/traceWalker.spec.ts (new)
runtime/client/src/modules/reels/reelsModule.ts    (mod)  invoke('spin') + use shared safeArea
runtime/client/src/modules/reels/reelsModule.invoke.spec.ts (new)
runtime/client/src/modules/safeArea.ts             (new)  landscapeSafeArea extracted from reels
runtime/client/src/modules/meter/meterModule.ts    (new)  MeterModule + buildMeterDesired
runtime/client/src/modules/meter/meterModule.spec.ts (new)
runtime/client/src/modules/moduleManager.ts        (mod)  byId()
runtime/client/src/modules/moduleManager.spec.ts   (mod)  byId test
runtime/client/src/engine.ts                       (mod)  register 'meter'
runtime/client/src/play/presentationConfig.ts      (mod)  extract validatePresentationShape
runtime/client/src/play/playMode.ts                (mod)  composed branch + buildComposedPlayDocument
runtime/client/src/play/playMode.spec.ts           (mod)  composed tests + harness fields
runtime/client/src/main.ts                         (mod)  resolveTarget wiring
runtime/client/src/play/goldenWalk.spec.ts         (new)  kernel golden-vector parity
runtime/client/playwright.config.ts                (mod)  third webServer (composed.pkg, :9102)
runtime/client/e2e/playmode-composed.e2e.spec.ts   (new)
```

Fixtures consumed (read-only, never edited — changing one is a re-certification event): `trusted/math/fixtures/composed/{proof_game.def.json, trace_seed_0.json, trace_seed_292.json, trace_seed_3395.json, trace_seed_8.json}`. The composed demo package `runtime/server/demo/composed.pkg` is checked in (3×3 reels, symbols `0,1,2,9`, meter target 6, mechanic ids `main_reels`/`bonus_meter`).

---

### Task 1: Mirror types + wire additions

**Files:**
- Create: `runtime/client/src/play/composedTypes.ts`
- Test: `runtime/client/src/play/composedTypes.spec.ts`
- Modify: `runtime/client/src/play/wireTypes.ts`
- Modify: `runtime/client/src/play/outcomeAdapter.ts`
- Modify: `runtime/client/src/play/outcomeAdapter.spec.ts` (one cast, behavior unchanged)

**Interfaces:**
- Consumes: `PlayModeError` from `./presentationConfig`.
- Produces: `ITriggerData`, `ITraceEntry`, `IGameDefinition`, `IMechanicDecl`, `validateDefinition(raw: unknown): IGameDefinition` (all from `play/composedTypes.ts`); `IComposedOutcomeWire`, `ISpinResponse.trace?: ITraceEntry[]`, `IHandshakeResponse.definition?: unknown` (from `play/wireTypes.ts`). Later tasks import these exact names.

- [ ] **Step 1: Write the failing test**

`runtime/client/src/play/composedTypes.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateDefinition } from './composedTypes';
import { PlayModeError } from './presentationConfig';

const DEF = {
  family: 'composed@1',
  mechanics: [
    { id: 'main_reels', type: 'reels@1', config: { strips: [[0]], rows: 1 } },
    { id: 'bonus_meter', type: 'meter@1', config: { target: 6, count_symbol: 9 } },
  ],
  states: [],
  start: 'base',
  transitions: [],
  caps: { max_steps: 100 },
};

describe('validateDefinition', () => {
  it('accepts a composed@1 definition and returns it typed', () => {
    const def = validateDefinition(DEF);
    expect(def.mechanics.map((m) => m.id)).toEqual(['main_reels', 'bonus_meter']);
    expect(def.mechanics[1].type).toBe('meter@1');
  });

  it('rejects a missing/empty definition', () => {
    expect(() => validateDefinition(undefined)).toThrow(PlayModeError);
    expect(() => validateDefinition(null)).toThrow(/definition/);
  });

  it('rejects a wrong family', () => {
    expect(() => validateDefinition({ ...DEF, family: 'slots@1' })).toThrow(/family/);
  });

  it('rejects mechanics that are missing, empty, or malformed', () => {
    expect(() => validateDefinition({ ...DEF, mechanics: [] })).toThrow(/mechanics/);
    expect(() => validateDefinition({ ...DEF, mechanics: [{ id: 'x' }] })).toThrow(/mechanic/);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run (worktree root): `npx nx test client`
Expected: FAIL — `Cannot find module './composedTypes'` (or equivalent).

- [ ] **Step 3: Write the implementation**

`runtime/client/src/play/composedTypes.ts`:

```ts
import { PlayModeError } from './presentationConfig';

/** Mirrors of the Rust composed@1 wire shapes
 *  (trusted/math/src/mechanics/composed/{definition,trace}.rs). Hand-written;
 *  the kernel golden vectors in goldenWalk.spec.ts are the drift alarm.
 *  Numeric policy (SP2 §5): seed is a string (u64 can exceed 2^53); payouts
 *  are bet-multiple u64s far below 2^53 and stay JSON numbers. */

export type ITriggerData =
  | { kind: 'reels'; grid: number[][]; payout: number }
  | { kind: 'meter'; fill: number; target: number };

export type ITraceEntry =
  | { t: 'round_start'; seed: string }
  | { t: 'state_enter'; state: string }
  | { t: 'step'; n: number }
  | { t: 'trigger'; mechanic: string; name: string; events: string[]; data: ITriggerData }
  | { t: 'transition'; on: string; to?: string; effect?: string }
  | { t: 'state_exit'; state: string; payout: number }
  | { t: 'round_end'; total_payout: number };

export interface IMechanicDecl {
  id: string;
  type: string;
  config: unknown;
}

export interface IBinding {
  mechanic: string;
  override?: unknown;
}

export interface IStepsSpec {
  budget: number | string;
  initial?: number;
}

export interface IStateDef {
  id: string;
  bindings: IBinding[];
  steps: IStepsSpec;
  script: Array<{ invoke: string }>;
}

export interface ITransitionRow {
  from: string;
  on: string;
  to?: string;
  effect?: string;
}

export interface IGameDefinition {
  family: string;
  mechanics: IMechanicDecl[];
  states: IStateDef[];
  start: string;
  transitions: ITransitionRow[];
  caps: { max_steps: number };
}

/** Narrow an opaque handshake `definition` to a playable composed@1 Game
 *  Definition, or throw a PlayModeError the caller renders visibly. Checks
 *  only what the client consumes (family + mechanics list); the server
 *  already compiled the definition. */
export function validateDefinition(raw: unknown): IGameDefinition {
  if (!raw || typeof raw !== 'object') {
    throw new PlayModeError('handshake definition is empty');
  }
  const d = raw as Record<string, unknown>;
  if (d.family !== 'composed@1') {
    throw new PlayModeError(`unsupported definition family: ${String(d.family)}`);
  }
  if (!Array.isArray(d.mechanics) || d.mechanics.length === 0) {
    throw new PlayModeError('definition has no mechanics');
  }
  for (const m of d.mechanics as Array<Record<string, unknown> | null>) {
    if (!m || typeof m.id !== 'string' || typeof m.type !== 'string' || m.config === undefined) {
      throw new PlayModeError('definition mechanic missing id/type/config');
    }
  }
  return raw as IGameDefinition;
}
```

Modify `runtime/client/src/play/wireTypes.ts` — make the outcome union discriminated by mechanic literals and add the SP2 fields. The full new file:

```ts
import type { ITraceEntry } from './composedTypes';

/** The reels presentation manifest the package carries (server /handshake). */
export interface IPresentation {
  cols: number;
  rows: number;
  symbols: string[];
  parentId?: string;
}

/** GET /handshake response. `presentation`/`definition` are opaque JSON until
 *  validated; `definition` is present for composed@1 packages, absent for slots. */
export interface IHandshakeResponse {
  package_id: string;
  package_version: number;
  mechanic: string;
  presentation: unknown;
  definition?: unknown;
}

/** The `slots@1` arm of the server's mechanic-tagged outcome union. */
export interface ISlotsOutcomeWire {
  mechanic: 'slots@1';
  base_grid: number[][];
  base_payout: number;
  feature_payout: number;
  total_payout: number;
  features: unknown[];
}

/** The `composed@1` summary arm — per-state payouts live in the trace. */
export interface IComposedOutcomeWire {
  mechanic: 'composed@1';
  total_payout: number;
}

/** POST /spin response. `seed` is a string (a u64 that can exceed 2^53);
 *  `trace` is present for composed@1, absent for slots. */
export interface ISpinResponse {
  seed: string;
  bet: number;
  outcome: ISlotsOutcomeWire | IComposedOutcomeWire;
  trace?: ITraceEntry[];
}

/** The thin transport the play subsystem depends on (impl in runtimeClient.ts). */
export interface IRuntimeClient {
  handshake(): Promise<IHandshakeResponse>;
  spin(bet?: number): Promise<ISpinResponse>;
}
```

Modify `runtime/client/src/play/outcomeAdapter.ts` — the guard now also narrows the union (behavior identical):

```ts
export function toClientOutcome(res: ISpinResponse): IOutcome {
  const o = res.outcome;
  if (o.mechanic !== 'slots@1') {
    throw new Error(`unsupported mechanic: ${o.mechanic}`);
  }
  return { grid: o.base_grid.map((reel) => reel.map((sym) => String(sym))) };
}
```

Modify `runtime/client/src/play/outcomeAdapter.spec.ts` line 48 — `mechanic` is now a literal type, so the unsupported-mechanic test needs a cast:

```ts
(bad.outcome as { mechanic: string }).mechanic = 'poker@1';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx nx test client` — all green (new spec passes; outcomeAdapter/playMode specs untouched semantically).
Run: `npx nx typecheck client` — green (proves the union narrowing compiles).

- [ ] **Step 5: Commit**

```bash
git add runtime/client/src/play
git commit -m "feat(runtime-client): composed@1 mirror types + wire trace/definition fields"
```

---

### Task 2: TraceWalker

**Files:**
- Create: `runtime/client/src/orchestration/traceWalker.ts`
- Test: `runtime/client/src/orchestration/traceWalker.spec.ts`

**Interfaces:**
- Consumes: `ITraceEntry`, `ITriggerData` from `../play/composedTypes` (Task 1).
- Produces: `ITriggerTarget { invoke(trigger: string, data: ITriggerData): Promise<void> }`; `TraceWalker` with constructor deps `{ bus: { emit(event: string, payload: unknown): void }; resolve: (mechanicId: string) => ITriggerTarget | null }` and `walk(entries: ITraceEntry[]): Promise<void>`. Bus events emitted: `round:start {seed}`, `state:enter {state}`, `step {n}`, `transition {on, to, effect}`, `state:exit {state, payout}`, `round:complete {total_payout}`.

- [ ] **Step 1: Write the failing test**

`runtime/client/src/orchestration/traceWalker.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { TraceWalker, type ITriggerTarget } from './traceWalker';
import { createBus } from './bus';
import type { ITraceEntry, ITriggerData } from '../play/composedTypes';

const REELS_DATA: ITriggerData = { kind: 'reels', grid: [[9], [9], [9]], payout: 8 };

const TRACE: ITraceEntry[] = [
  { t: 'round_start', seed: '8' },
  { t: 'state_enter', state: 'base' },
  { t: 'step', n: 1 },
  { t: 'trigger', mechanic: 'main_reels', name: 'spin', events: ['scatters:3'], data: REELS_DATA },
  { t: 'trigger', mechanic: 'bonus_meter', name: 'accumulate', events: [], data: { kind: 'meter', fill: 3, target: 6 } },
  { t: 'transition', on: 'scatters:3', to: 'fs1' },
  { t: 'state_exit', state: 'base', payout: 8 },
  { t: 'round_end', total_payout: 8 },
];

function harness(opts: { manual?: boolean } = {}) {
  const bus = createBus();
  const log: Array<{ event: string; payload: unknown }> = [];
  for (const ev of ['round:start', 'state:enter', 'step', 'transition', 'state:exit', 'round:complete']) {
    bus.on(ev, (payload) => log.push({ event: ev, payload }));
  }
  const invoked: Array<{ id: string; trigger: string; data: ITriggerData }> = [];
  const pendings: Array<() => void> = [];
  const target = (id: string): ITriggerTarget => ({
    invoke: (trigger, data) => {
      invoked.push({ id, trigger, data });
      if (!opts.manual) return Promise.resolve();
      return new Promise((resolve) => pendings.push(resolve));
    },
  });
  const targets = new Map([
    ['main_reels', target('main_reels')],
    ['bonus_meter', target('bonus_meter')],
  ]);
  const walker = new TraceWalker({ bus, resolve: (id) => targets.get(id) ?? null });
  return { walker, log, invoked, pendings };
}

describe('TraceWalker', () => {
  it('walks a trace: bus events in order, triggers dispatched by mechanic id', async () => {
    const h = harness();
    await h.walker.walk(TRACE);
    expect(h.log.map((l) => l.event)).toEqual(['round:start', 'state:enter', 'step', 'transition', 'state:exit', 'round:complete']);
    expect(h.log.at(-1)?.payload).toEqual({ total_payout: 8 });
    expect(h.invoked.map((i) => `${i.id}.${i.trigger}`)).toEqual(['main_reels.spin', 'bonus_meter.accumulate']);
  });

  it('awaits each trigger before advancing', async () => {
    const h = harness({ manual: true });
    void h.walker.walk(TRACE);
    // walk() runs synchronously up to the first await: 3 bus events, then the
    // first invoke parks. The second trigger must NOT have been dispatched.
    expect(h.invoked).toHaveLength(1);
    expect(h.log.map((l) => l.event)).toEqual(['round:start', 'state:enter', 'step']); // no transition yet
    h.pendings[0]!();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.invoked).toHaveLength(2);
    expect(h.log.map((l) => l.event)).toEqual(['round:start', 'state:enter', 'step']); // still parked on trigger 2
    h.pendings[1]!();
  });

  it('rejects on a trigger whose mechanic has no module', async () => {
    const bus = createBus();
    const walker = new TraceWalker({ bus, resolve: () => null });
    await expect(walker.walk(TRACE)).rejects.toThrow(/no module for mechanic: main_reels/);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx nx test client`
Expected: FAIL — `Cannot find module './traceWalker'`.

- [ ] **Step 3: Write the implementation**

`runtime/client/src/orchestration/traceWalker.ts`:

```ts
import type { ITraceEntry, ITriggerData } from '../play/composedTypes';

/** The awaited trigger seam a mechanic module exposes to the walker.
 *  ReelsModule and MeterModule implement it structurally. */
export interface ITriggerTarget {
  invoke(trigger: string, data: ITriggerData): Promise<void>;
}

export interface ITraceWalkerDeps {
  bus: { emit(event: string, payload: unknown): void };
  /** Module lookup by mechanic INSTANCE id (e.g. 'main_reels'), not type. */
  resolve: (mechanicId: string) => ITriggerTarget | null;
}

/** Steps the client through a served composed@1 lifecycle trace (spec §4):
 *  trigger entries dispatch to modules and are awaited before advancing;
 *  every other entry becomes a bus event — v1's presentation hook. The
 *  composed twin of Orchestrator (which keeps owning slots@1). */
export class TraceWalker {
  constructor(private readonly deps: ITraceWalkerDeps) {}

  async walk(entries: ITraceEntry[]): Promise<void> {
    for (const e of entries) {
      switch (e.t) {
        case 'trigger': {
          const target = this.deps.resolve(e.mechanic);
          if (!target) throw new Error(`no module for mechanic: ${e.mechanic}`);
          await target.invoke(e.name, e.data);
          break;
        }
        case 'round_start':
          this.deps.bus.emit('round:start', { seed: e.seed });
          break;
        case 'state_enter':
          this.deps.bus.emit('state:enter', { state: e.state });
          break;
        case 'step':
          this.deps.bus.emit('step', { n: e.n });
          break;
        case 'transition':
          this.deps.bus.emit('transition', { on: e.on, to: e.to, effect: e.effect });
          break;
        case 'state_exit':
          this.deps.bus.emit('state:exit', { state: e.state, payout: e.payout });
          break;
        case 'round_end':
          this.deps.bus.emit('round:complete', { total_payout: e.total_payout });
          break;
        default: {
          // Exhaustiveness guard; at runtime an unknown wire entry lands here.
          const never: never = e;
          throw new Error(`unknown trace entry: ${JSON.stringify(never)}`);
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx nx test client` — all green.

- [ ] **Step 5: Commit**

```bash
git add runtime/client/src/orchestration
git commit -m "feat(runtime-client): TraceWalker steps composed traces through module triggers"
```

---

### Task 3: ReelsModule.invoke

**Files:**
- Modify: `runtime/client/src/modules/reels/reelsModule.ts`
- Test: `runtime/client/src/modules/reels/reelsModule.invoke.spec.ts` (new file)

**Interfaces:**
- Consumes: `ITriggerData` (Task 1). Existing `ReelsModule` internals (`project/startSpinning/stopSpinning`, `reels:settled`).
- Produces: `ReelsModule.invoke(trigger: string, data: ITriggerData): Promise<void>` satisfying `ITriggerTarget` structurally (Task 2). Existing methods and the Orchestrator/slots path unchanged.

- [ ] **Step 1: Write the failing test**

`runtime/client/src/modules/reels/reelsModule.invoke.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ReelsModule } from './reelsModule';
import { createBus } from '../../orchestration/bus';
import type { IModuleHost } from '../module';

function harness() {
  const bus = createBus();
  let tick: ((dt: number) => void) | null = null;
  const host: IModuleHost = {
    snapshot: () => ({ version: 1, nodes: { root: { id: 'root', type: 'Root', props: {} } }, edges: [] }),
    emit: () => {},
    resolve: () => null,
    onTick: (cb) => {
      tick = cb;
      return () => (tick = null);
    },
    bus,
  };
  const mod = new ReelsModule({ id: 'main_reels', host, config: { cols: 3, rows: 1, symbols: ['0', '1', '9'] } });
  mod.mount();
  const pump = (ms: number) => {
    for (let t = 0; t < ms; t += 50) tick?.(50);
  };
  return { mod, bus, pump };
}

describe('ReelsModule.invoke (composed trigger seam)', () => {
  it('runs a served spin and resolves when the reels settle on the served grid', async () => {
    const h = harness();
    let done = false;
    const p = h.mod.invoke('spin', { kind: 'reels', grid: [[9], [9], [9]], payout: 8 }).then(() => (done = true));
    expect(done).toBe(false); // pending until the settle animation lands
    h.pump(3000); // > SETTLE_MS + stagger for 3 reels
    await p;
    expect(done).toBe(true);
    expect(h.mod.debugState()).toEqual({ phase: 'idle', grid: [['9'], ['9'], ['9']] });
  });

  it('rejects an unknown trigger or wrong data kind', async () => {
    const h = harness();
    await expect(h.mod.invoke('accumulate', { kind: 'meter', fill: 1, target: 6 })).rejects.toThrow(/unsupported/);
    await expect(h.mod.invoke('spin', { kind: 'meter', fill: 1, target: 6 })).rejects.toThrow(/unsupported/);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx nx test client`
Expected: FAIL — `h.mod.invoke is not a function`.

- [ ] **Step 3: Write the implementation**

In `runtime/client/src/modules/reels/reelsModule.ts`, add the import at the top:

```ts
import type { ITriggerData } from '../../play/composedTypes';
```

and add this method to `ReelsModule` (after `stopSpinning`):

```ts
  /** Composed trigger seam (TraceWalker): run one served spin end to end and
   *  resolve when the reels settle. The Orchestrator/slots path never calls this. */
  invoke(trigger: string, data: ITriggerData): Promise<void> {
    if (trigger !== 'spin' || data.kind !== 'reels') {
      return Promise.reject(new Error(`reels: unsupported trigger ${trigger} (${data.kind})`));
    }
    const grid = data.grid.map((reel) => reel.map((sym) => String(sym)));
    return new Promise((resolve) => {
      const off = this.host.bus.on('reels:settled', () => {
        off();
        resolve();
      });
      this.project(); // idempotent — ensures structure exists (as Orchestrator.spin does)
      this.startSpinning();
      this.stopSpinning({ grid });
    });
  }
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx nx test client` — all green, including all pre-existing reels specs.

- [ ] **Step 5: Commit**

```bash
git add runtime/client/src/modules/reels
git commit -m "feat(runtime-client): reels invoke('spin') trigger seam for the TraceWalker"
```

---

### Task 4: MeterModule + shared safe area + engine registration

**Files:**
- Create: `runtime/client/src/modules/safeArea.ts`
- Create: `runtime/client/src/modules/meter/meterModule.ts`
- Test: `runtime/client/src/modules/meter/meterModule.spec.ts`
- Modify: `runtime/client/src/modules/reels/reelsModule.ts` (use the shared helper; delete its private copy)
- Modify: `runtime/client/src/engine.ts` (register `'meter'`)

**Interfaces:**
- Consumes: `ITriggerData` (Task 1); `IGameModule`, `IModuleHost` (`modules/module.ts`); `validateConfig`/`IConfigSchema` (`modules/schema.ts`); `reconcileOps`, `IDesiredScene`, `IDesiredNode` (`modules/reconcile.ts`).
- Produces: `landscapeSafeArea(doc: IGameDocument): { width: number; height: number }` (from `modules/safeArea.ts`); `MeterModule` (type `'meter'`, config `{ target: integer, parentId: string }`) with `invoke(trigger, data): Promise<void>`, `debugState(): { fill: number; target: number }`, node ids `barId(id) = \`${id}:bar\``, `segId(id, i) = \`${id}:seg:${i}\``; bus event `meter:changed { fill, target }`; `METER_SCHEMA`, `buildMeterDesired` exported for tests. Engine registry key `'meter'`.

- [ ] **Step 1: Extract the shared safe-area helper (pure refactor, existing tests are the net)**

Create `runtime/client/src/modules/safeArea.ts`:

```ts
import type { IGameDocument } from '../model/document';

/** The Root's landscape safe area, defaulting to 1280×720. Extracted from
 *  ReelsModule so meter and reels center against the same frame. */
export function landscapeSafeArea(doc: IGameDocument): { width: number; height: number } {
  const root = Object.values(doc.nodes).find((n) => n.type === 'Root');
  const land = (root?.props?.safeArea as { landscape?: { width?: number; height?: number } } | undefined)?.landscape;
  const w = typeof land?.width === 'number' && land.width > 0 ? land.width : 1280;
  const h = typeof land?.height === 'number' && land.height > 0 ? land.height : 720;
  return { width: w, height: h };
}
```

In `runtime/client/src/modules/reels/reelsModule.ts`: add `import { landscapeSafeArea } from '../safeArea';`, delete the private `landscapeSafeArea` method (lines 143–149 of the current file), and change its one call site in `withCenteredOrigin` from `this.landscapeSafeArea(doc)` to `landscapeSafeArea(doc)`.

Run: `npx nx test client` — all green (pure move; reels specs are the net).

- [ ] **Step 2: Write the failing meter test**

`runtime/client/src/modules/meter/meterModule.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MeterModule, buildMeterDesired, segId, barId } from './meterModule';
import { createBus } from '../../orchestration/bus';
import type { IModuleHost } from '../module';
import type { JsonValue } from '../../model/document';
import type { Op } from '../../model/ops';

function harness(config: Record<string, JsonValue> = { target: 6 }) {
  const bus = createBus();
  let tick: ((dt: number) => void) | null = null;
  const batches: Op[][] = [];
  const host: IModuleHost = {
    snapshot: () => ({ version: 1, nodes: { root: { id: 'root', type: 'Root', props: {} } }, edges: [] }),
    emit: (ops) => void batches.push(ops),
    resolve: () => null,
    onTick: (cb) => {
      tick = cb;
      return () => (tick = null);
    },
    bus,
  };
  const mod = new MeterModule({ id: 'bonus_meter', host, config });
  mod.mount();
  const pump = (ms: number) => {
    for (let t = 0; t < ms; t += 50) tick?.(50);
  };
  return { mod, bus, batches, pump };
}

describe('buildMeterDesired', () => {
  it('emits a bar container plus target segments, lit up to fill', () => {
    const scene = buildMeterDesired('bonus_meter', { target: 4, parentId: 'root' }, 2, { width: 1280, height: 720 });
    expect(scene.nodes).toHaveLength(5); // 1 bar + 4 segments
    expect(scene.nodes[0]).toMatchObject({ id: barId('bonus_meter'), type: 'Container', parent: 'root' });
    const fills = scene.nodes.slice(1).map((n) => n.props.fill);
    expect(new Set(fills.slice(0, 2)).size).toBe(1); // first two lit (same color)
    expect(fills[0]).not.toBe(fills[2]); // lit differs from unlit
    expect(scene.nodes[4].id).toBe(segId('bonus_meter', 3));
  });
});

describe('MeterModule.invoke (composed trigger seam)', () => {
  it('animates to the served fill, emits meter:changed, then resolves', async () => {
    const h = harness();
    const changed: unknown[] = [];
    h.bus.on('meter:changed', (p) => changed.push(p));
    let done = false;
    const p = h.mod.invoke('accumulate', { kind: 'meter', fill: 3, target: 6 }).then(() => (done = true));
    expect(done).toBe(false); // pending until segments light
    h.pump(1000); // 3 segments × 150ms
    await p;
    expect(h.mod.debugState()).toEqual({ fill: 3, target: 6 });
    expect(changed).toEqual([{ fill: 3, target: 6 }]);
  });

  it('snaps down immediately when the served fill is lower (new round)', async () => {
    const h = harness();
    const p1 = h.mod.invoke('accumulate', { kind: 'meter', fill: 3, target: 6 });
    h.pump(1000);
    await p1;
    await h.mod.invoke('accumulate', { kind: 'meter', fill: 1, target: 6 }); // no pumping needed
    expect(h.mod.debugState().fill).toBe(1);
  });

  it('lights segments via setProp ops on its own node ids', async () => {
    const h = harness();
    const p = h.mod.invoke('accumulate', { kind: 'meter', fill: 1, target: 6 });
    h.pump(500);
    await p;
    expect(h.batches.flat().some((op) => op.kind === 'setProp' && op.id === segId('bonus_meter', 0) && op.path === 'fill')).toBe(true);
  });

  it('rejects an unknown trigger or wrong data kind', async () => {
    const h = harness();
    await expect(h.mod.invoke('spin', { kind: 'reels', grid: [[0]], payout: 0 })).rejects.toThrow(/unsupported/);
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `npx nx test client`
Expected: FAIL — `Cannot find module './meterModule'`.

- [ ] **Step 4: Write the implementation**

`runtime/client/src/modules/meter/meterModule.ts`:

```ts
// runtime/client/src/modules/meter/meterModule.ts
import type { JsonValue } from '../../model/document';
import type { IGameModule, IModuleHost } from '../module';
import { validateConfig, type IConfigSchema } from '../schema';
import { reconcileOps, type IDesiredNode, type IDesiredScene } from '../reconcile';
import type { Op } from '../../model/ops';
import type { ITriggerData } from '../../play/composedTypes';
import { landscapeSafeArea } from '../safeArea';

export const METER_SCHEMA: IConfigSchema = {
  target: { type: 'integer', default: 4, min: 1, max: 64 },
  parentId: { type: 'string', default: 'root', binding: 'parent' },
};

const SEG_W = 48;
const SEG_H = 20;
const SEG_GAP = 8;
const LIT = '#ffd54a';
const UNLIT = '#2a2a2a';
const STEP_MS = 150; // per-segment light-up cadence

export function barId(moduleId: string): string {
  return `${moduleId}:bar`;
}

export function segId(moduleId: string, i: number): string {
  return `${moduleId}:seg:${i}`;
}

interface IMeterConfig {
  target: number;
  parentId: string;
}

/** Pure: the desired node set — a segment bar centered near the bottom of the
 *  safe area, `fill` segments lit (placeholder art, like reels' colored cells). */
export function buildMeterDesired(moduleId: string, cfg: IMeterConfig, fill: number, safe: { width: number; height: number }): IDesiredScene {
  const span = SEG_W + SEG_GAP;
  const barWidth = cfg.target * span - SEG_GAP;
  const nodes: IDesiredNode[] = [
    {
      id: barId(moduleId),
      type: 'Container',
      props: { position: { x: safe.width / 2 - barWidth / 2, y: safe.height - SEG_H - 24 } },
      parent: cfg.parentId,
    },
  ];
  for (let i = 0; i < cfg.target; i++) {
    nodes.push({
      id: segId(moduleId, i),
      type: 'Sprite',
      props: { position: { x: i * span, y: 0 }, size: { width: SEG_W, height: SEG_H }, fill: i < fill ? LIT : UNLIT },
      parent: barId(moduleId),
    });
  }
  return { nodes };
}

/** meter@1 presentation: renders the server-served fill level — the module
 *  never counts symbols itself (the client never re-runs math). */
export class MeterModule implements IGameModule {
  readonly type = 'meter';
  readonly configSchema = METER_SCHEMA;
  private config: Record<string, JsonValue>;
  private fill = 0;
  private pending: { to: number; target: number; elapsed: number; resolve: () => void } | null = null;
  private offTick: (() => void) | null = null;

  constructor(private readonly args: { id: string; host: IModuleHost; config?: Record<string, JsonValue> }) {
    this.config = { ...(args.config ?? {}) };
  }

  get id(): string {
    return this.args.id;
  }

  private get host(): IModuleHost {
    return this.args.host;
  }

  private cfg(): IMeterConfig {
    const { ok, value, errors } = validateConfig<IMeterConfig>(METER_SCHEMA, this.config);
    if (!ok) console.warn('[meter] invalid config, using defaults for:', errors.join('; '));
    return value;
  }

  project(): void {
    const snap = this.host.snapshot();
    const desired = buildMeterDesired(this.id, this.cfg(), this.fill, landscapeSafeArea(snap));
    const owns = (nodeId: string) => nodeId.startsWith(`${this.id}:`);
    this.host.emit(reconcileOps(snap, desired, owns));
  }

  mount(): void {
    this.offTick = this.host.onTick((dt) => this.update(dt));
  }

  dispose(): void {
    this.offTick?.();
    this.offTick = null;
  }

  update(dtMs: number): void {
    const p = this.pending;
    if (!p) return;
    p.elapsed += dtMs;
    while (p.elapsed >= STEP_MS && this.fill < p.to) {
      p.elapsed -= STEP_MS;
      this.setFill(this.fill + 1);
    }
    if (this.fill >= p.to) {
      this.pending = null;
      this.host.bus.emit('meter:changed', { fill: this.fill, target: p.target });
      p.resolve();
    }
  }

  /** Composed trigger seam (TraceWalker): animate to the served fill. A lower
   *  fill (a new round started) snaps immediately — fill is server-authoritative. */
  invoke(trigger: string, data: ITriggerData): Promise<void> {
    if (trigger !== 'accumulate' || data.kind !== 'meter') {
      return Promise.reject(new Error(`meter: unsupported trigger ${trigger} (${data.kind})`));
    }
    const to = Math.min(data.fill, this.cfg().target);
    if (to <= this.fill) {
      this.setFill(to);
      this.host.bus.emit('meter:changed', { fill: this.fill, target: data.target });
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.pending = { to, target: data.target, elapsed: 0, resolve };
    });
  }

  private setFill(fill: number): void {
    this.fill = fill;
    const ops: Op[] = [];
    for (let i = 0; i < this.cfg().target; i++) {
      ops.push({ kind: 'setProp', id: segId(this.id, i), path: 'fill', value: i < fill ? LIT : UNLIT });
    }
    this.host.emit(ops);
  }

  debugState(): { fill: number; target: number } {
    return { fill: this.fill, target: this.cfg().target };
  }
}
```

In `runtime/client/src/engine.ts`, add the import and registration next to reels:

```ts
import { MeterModule } from './modules/meter/meterModule';
```

```ts
  registry.register('reels', (args) => new ReelsModule(args));
  registry.register('meter', (args) => new MeterModule(args));
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `npx nx test client` — all green.

- [ ] **Step 6: Commit**

```bash
git add runtime/client/src/modules runtime/client/src/engine.ts
git commit -m "feat(runtime-client): MeterModule segment bar + shared safe-area helper"
```

---

### Task 5: Play mode composed branch + wiring

**Files:**
- Modify: `runtime/client/src/modules/moduleManager.ts` (+ its spec)
- Modify: `runtime/client/src/play/presentationConfig.ts`
- Modify: `runtime/client/src/play/playMode.ts` (+ its spec)
- Modify: `runtime/client/src/main.ts`

**Interfaces:**
- Consumes: `validateDefinition`, `IGameDefinition` (Task 1); `TraceWalker`, `ITriggerTarget` (Task 2); modules with `invoke` (Tasks 3–4); `IModuleDecl` from `model/document.ts` (`{ id; type; config? }`).
- Produces: `ModuleManager.byId(id: string): IGameModule | undefined`; `validatePresentationShape(p: unknown): IPresentation`; `buildComposedPlayDocument(def: IGameDefinition, pres: IPresentation, rootSize?): IGameDocument`; `IPlayModeDeps` gains `resolveTarget: (mechanicId: string) => ITriggerTarget | null` and `IPlayBus` gains `emit(event: string, payload: unknown): void`.

- [ ] **Step 1: Write the failing tests**

Add to `runtime/client/src/modules/moduleManager.spec.ts`, inside the existing `describe('ModuleManager', …)` block (its `setup()` helper provides `registry`/`host`):

```ts
  it('byId returns the instance declared under that id', () => {
    const { registry, host } = setup();
    const manager = new ModuleManager({ registry, host });
    manager.sync([{ id: 'main_reels', type: 'reels', config: { parentId: 'root' } }]);
    expect(manager.byId('main_reels')?.id).toBe('main_reels');
    expect(manager.byId('nope')).toBeUndefined();
  });
```

In `runtime/client/src/play/playMode.spec.ts`:

1. Extend the harness: add `emit: (event, payload) => void busEmits.push({ event, payload })` to the `bus` fake (add `const busEmits: Array<{ event: string; payload: unknown }> = []`), and add `resolveTarget: (id) => targets.get(id) ?? null` with `const targets = new Map<string, ITriggerTarget>()`. Return `targets` and `busEmits` from the harness. Import `type { ITriggerTarget }` from `'../orchestration/traceWalker'`.
2. Add composed fixtures and tests:

```ts
const COMPOSED_HS: IHandshakeResponse = {
  package_id: 'bloom-demo-composed',
  package_version: 1,
  mechanic: 'composed@1',
  presentation: { cols: 3, rows: 3, symbols: ['0', '1', '2', '9'], parentId: 'root' },
  definition: {
    family: 'composed@1',
    mechanics: [
      { id: 'main_reels', type: 'reels@1', config: {} },
      { id: 'bonus_meter', type: 'meter@1', config: { target: 6, count_symbol: 9 } },
    ],
    states: [],
    start: 'base',
    transitions: [],
    caps: { max_steps: 100 },
  },
};

const COMPOSED_SPIN: ISpinResponse = {
  seed: '8',
  bet: 1,
  outcome: { mechanic: 'composed@1', total_payout: 8 },
  trace: [
    { t: 'round_start', seed: '8' },
    { t: 'state_enter', state: 'base' },
    { t: 'trigger', mechanic: 'main_reels', name: 'spin', events: [], data: { kind: 'reels', grid: [[9], [9], [9]], payout: 8 } },
    { t: 'trigger', mechanic: 'bonus_meter', name: 'accumulate', events: [], data: { kind: 'meter', fill: 3, target: 6 } },
    { t: 'state_exit', state: 'base', payout: 8 },
    { t: 'round_end', total_payout: 8 },
  ],
};

describe('buildComposedPlayDocument', () => {
  const def = COMPOSED_HS.definition as IGameDefinition;
  const pres = COMPOSED_HS.presentation as IPresentation;

  it('maps mechanics to module decls keyed by instance id', () => {
    const doc = buildComposedPlayDocument(def, pres);
    expect(doc.nodes.root.type).toBe('Root');
    expect(doc.modules).toEqual([
      { id: 'main_reels', type: 'reels', config: { cols: 3, rows: 3, symbols: ['0', '1', '2', '9'], parentId: 'root' } },
      { id: 'bonus_meter', type: 'meter', config: { target: 6 } },
    ]);
  });

  it('throws on an unknown mechanic type', () => {
    const bad = { ...def, mechanics: [{ id: 'x', type: 'dice@1', config: {} }] };
    expect(() => buildComposedPlayDocument(bad, pres)).toThrow(/dice@1/);
  });

  it('throws on a meter config without a numeric target', () => {
    const bad = { ...def, mechanics: [{ id: 'm', type: 'meter@1', config: {} }] };
    expect(() => buildComposedPlayDocument(bad, pres)).toThrow(/target/);
  });
});

describe('startPlayMode (composed@1)', () => {
  function composedHarness(over: Parameters<typeof harness>[0] = {}) {
    const h = harness({ handshake: async () => COMPOSED_HS, spin: async () => COMPOSED_SPIN, ...over });
    const invoked: string[] = [];
    const target = (id: string): ITriggerTarget => ({
      invoke: (trigger) => {
        invoked.push(`${id}.${trigger}`);
        return Promise.resolve();
      },
    });
    h.targets.set('main_reels', target('main_reels'));
    h.targets.set('bonus_meter', target('bonus_meter'));
    return { ...h, invoked };
  }

  it('inits the composed document and reveals Spin', async () => {
    const h = composedHarness();
    await startPlayMode(h.deps);
    expect(h.initCalls).toHaveLength(1);
    const doc = (h.initCalls[0] as { document: { modules: unknown[] } }).document;
    expect(doc.modules).toHaveLength(2);
    expect(h.spinButton.hidden).toBe(false);
  });

  it('on Spin: walks the served trace and re-enables the button when done', async () => {
    const h = composedHarness();
    await startPlayMode(h.deps);
    h.spinButton.click();
    await vi.waitFor(() => expect(h.invoked).toEqual(['main_reels.spin', 'bonus_meter.accumulate']));
    await vi.waitFor(() => expect(h.spinButton.disabled).toBe(false));
    expect(h.busEmits.some((e) => e.event === 'round:complete')).toBe(true);
    expect(h.errorEl.hidden).toBe(true);
  });

  it('a composed spin without a trace is surfaced as an error and re-enables Spin', async () => {
    const h = composedHarness({ spin: async () => ({ ...COMPOSED_SPIN, trace: undefined }) });
    await startPlayMode(h.deps);
    h.spinButton.click();
    await vi.waitFor(() => expect(h.errorEl.textContent).toContain('trace'));
    expect(h.spinButton.disabled).toBe(false);
  });

  it('an unknown handshake mechanic is surfaced and Spin stays hidden', async () => {
    const h = harness({ handshake: async () => ({ ...HS, mechanic: 'poker@1' }) });
    await startPlayMode(h.deps);
    expect(h.errorEl.hidden).toBe(false);
    expect(h.spinButton.hidden).toBe(true);
  });
});
```

Imports to add at the top of the spec: `buildComposedPlayDocument` from `'./playMode'`, `type { IGameDefinition }` from `'./composedTypes'`, `type { IPresentation }` from `'./wireTypes'`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx nx test client`
Expected: FAIL — `byId is not a function`; `buildComposedPlayDocument` not exported; harness type errors on `resolveTarget`.

- [ ] **Step 3: Write the implementation**

`runtime/client/src/modules/moduleManager.ts` — add after `byType`:

```ts
  /** Instance lookup by declaration id — the TraceWalker resolves mechanic
   *  instance ids (e.g. 'main_reels') through this. */
  byId(id: string): IGameModule | undefined {
    return this.modules.get(id);
  }
```

`runtime/client/src/play/presentationConfig.ts` — split the shape check out of `validatePresentation` (public behavior unchanged):

```ts
/** Shape-check an opaque presentation manifest (no mechanic gate) — the
 *  composed path validates mechanic + definition separately. */
export function validatePresentationShape(p: unknown): IPresentation {
  if (!p || typeof p !== 'object') {
    throw new PlayModeError('handshake presentation is empty');
  }
  const rec = p as Record<string, unknown>;
  if (typeof rec.cols !== 'number' || typeof rec.rows !== 'number' || !Array.isArray(rec.symbols) || rec.symbols.some((s) => typeof s !== 'string')) {
    throw new PlayModeError('handshake presentation missing cols/rows/symbols');
  }
  return p as IPresentation;
}

/** Narrow an opaque handshake to a playable slots@1 presentation, or throw a
 *  PlayModeError the caller renders visibly (never a silent blank scene). */
export function validatePresentation(hs: IHandshakeResponse): IPresentation {
  if (hs.mechanic !== 'slots@1') {
    throw new PlayModeError(`unsupported mechanic: ${hs.mechanic}`);
  }
  return validatePresentationShape(hs.presentation);
}
```

`runtime/client/src/play/playMode.ts` — update the imports: the existing `../model/document` type import becomes `import type { IGameDocument, JsonValue, IModuleDecl } from '../model/document';`, the existing `./wireTypes` import gains `IHandshakeResponse`, and add:

```ts
import { validateDefinition, type IGameDefinition } from './composedTypes';
import { validatePresentation, validatePresentationShape, toReelsConfig, PlayModeError } from './presentationConfig';
import { TraceWalker, type ITriggerTarget } from '../orchestration/traceWalker';
```

(the `validatePresentation, toReelsConfig` line it replaces goes away).

Extend the seams:

```ts
export interface IPlayBus {
  on(event: string, cb: (payload: unknown) => void): () => void;
  emit(event: string, payload: unknown): void;
}
export interface IPlayModeDeps {
  client: IRuntimeClient;
  host: IPlayHost;
  bus: IPlayBus;
  orchestrator: IPlayOrchestrator;
  /** TraceWalker module lookup by mechanic instance id (composed@1 only). */
  resolveTarget: (mechanicId: string) => ITriggerTarget | null;
  spinButton: HTMLButtonElement;
  errorEl: HTMLElement;
  rootSize?: { width: number; height: number };
}
```

Add the composed document builder next to `buildPlayDocument`:

```ts
function toMeterConfig(config: unknown): Record<string, JsonValue> {
  const target = (config as { target?: unknown } | null)?.target;
  if (typeof target !== 'number') {
    throw new PlayModeError('meter@1 mechanic config missing numeric target');
  }
  return { target };
}

/** Build the composed init document: module instances come from the Game
 *  Definition's mechanics list (keyed by instance id); the presentation
 *  manifest stays the visual source of truth for the reels grid. */
export function buildComposedPlayDocument(def: IGameDefinition, pres: IPresentation, rootSize = DEFAULT_ROOT_SIZE): IGameDocument {
  const modules = def.mechanics.map((m): IModuleDecl => {
    if (m.type === 'reels@1') return { id: m.id, type: 'reels', config: toReelsConfig(pres) };
    if (m.type === 'meter@1') return { id: m.id, type: 'meter', config: toMeterConfig(m.config) };
    throw new PlayModeError(`unsupported mechanic type: ${m.type}`);
  });
  return {
    version: 1,
    nodes: {
      root: { id: 'root', type: 'Root', props: { width: rootSize.width, height: rootSize.height } },
    },
    edges: [],
    modules,
  };
}
```

Add the composed spin runner next to `runSpin`:

```ts
async function runComposedSpin(deps: IPlayModeDeps, walker: TraceWalker): Promise<void> {
  deps.spinButton.disabled = true;
  try {
    const res = await deps.client.spin(1);
    if (!res.trace) throw new PlayModeError('composed spin response carries no trace');
    await walker.walk(res.trace);
  } catch (err) {
    showError(deps.errorEl, err);
  } finally {
    deps.spinButton.disabled = false;
  }
}
```

Replace `startPlayMode` with the branching version (slots path byte-for-byte as today):

```ts
/** Boot direct play-mode: handshake -> render scene -> wire the Spin gesture.
 *  Branches on the package family: slots@1 drives the Orchestrator (unchanged);
 *  composed@1 walks served traces through the TraceWalker. */
export async function startPlayMode(deps: IPlayModeDeps): Promise<void> {
  let hs: IHandshakeResponse;
  try {
    hs = await deps.client.handshake();
    if (hs.mechanic === 'composed@1') {
      const def = validateDefinition(hs.definition);
      const pres = validatePresentationShape(hs.presentation);
      await deps.host.handle({ v: 1, kind: 'init', id: 'play', document: buildComposedPlayDocument(def, pres, deps.rootSize) });
      const walker = new TraceWalker({ bus: deps.bus, resolve: deps.resolveTarget });
      deps.spinButton.hidden = false;
      deps.spinButton.addEventListener('click', () => {
        void runComposedSpin(deps, walker);
      });
      return;
    }
    const pres = validatePresentation(hs); // throws on any non-slots mechanic
    await deps.host.handle({ v: 1, kind: 'init', id: 'play', document: buildPlayDocument(pres, deps.rootSize) });
  } catch (err) {
    showError(deps.errorEl, err);
    return;
  }
  deps.bus.on('reels:settled', () => {
    deps.spinButton.disabled = false;
  });
  deps.spinButton.hidden = false;
  deps.spinButton.addEventListener('click', () => {
    void runSpin(deps);
  });
}
```

(`IHandshakeResponse` joins the existing `wireTypes` type imports.)

`runtime/client/src/main.ts` — add `resolveTarget` to the `startPlayMode` call (import `type { ITriggerTarget }` from `'./orchestration/traceWalker'`):

```ts
  void startPlayMode({
    client,
    host,
    bus: modules.bus,
    orchestrator: modules.orchestrator,
    resolveTarget: (id) => {
      const m = modules.manager.byId(id) as unknown as Partial<ITriggerTarget> | undefined;
      return m && typeof m.invoke === 'function' ? (m as ITriggerTarget) : null;
    },
    spinButton,
    errorEl,
  });
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx nx test client` — all green (all pre-existing slots playMode tests included).
Run: `npx nx typecheck client` — green.

- [ ] **Step 5: Commit**

```bash
git add runtime/client/src
git commit -m "feat(runtime-client): composed@1 play mode — definition-driven modules + trace walking"
```

---

### Task 6: Golden-vector walk suite (kernel parity)

**Files:**
- Test: `runtime/client/src/play/goldenWalk.spec.ts` (new; no production code — Tasks 1–2 are the code under test)

**Interfaces:**
- Consumes: `TraceWalker`, `ITriggerTarget` (Task 2); `validateDefinition`, `ITraceEntry`, `ITriggerData` (Task 1); fixtures `trusted/math/fixtures/composed/*` (read-only).

- [ ] **Step 1: Write the suite (it should pass immediately — it's the parity gate, not TDD of new code)**

`runtime/client/src/play/goldenWalk.spec.ts`:

```ts
// Kernel golden-vector parity (spec §7): the client must parse and walk every
// checked-in (definition, seed) -> trace fixture to completion, and module
// end-states must match the trace's claims. Fixtures live in trusted/math and
// are shared with the kernel + server suites — never edited here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TraceWalker, type ITriggerTarget } from '../orchestration/traceWalker';
import { validateDefinition, type ITraceEntry, type ITriggerData } from './composedTypes';
import { createBus } from '../orchestration/bus';

const fixture = (name: string): string => fileURLToPath(new URL(`../../../../trusted/math/fixtures/composed/${name}`, import.meta.url));

const TRACES = ['trace_seed_0.json', 'trace_seed_292.json', 'trace_seed_3395.json', 'trace_seed_8.json'];

class RecordingTarget implements ITriggerTarget {
  calls: Array<{ trigger: string; data: ITriggerData }> = [];
  invoke(trigger: string, data: ITriggerData): Promise<void> {
    this.calls.push({ trigger, data });
    return Promise.resolve();
  }
}

describe('golden-vector walk (kernel parity)', () => {
  it('the proof-game definition passes the client boundary validator', () => {
    const def = validateDefinition(JSON.parse(readFileSync(fixture('proof_game.def.json'), 'utf8')));
    expect(def.mechanics.map((m) => m.type)).toEqual(['reels@1', 'meter@1']);
    expect(def.mechanics.map((m) => m.id)).toEqual(['main_reels', 'bonus_meter']);
  });

  for (const name of TRACES) {
    it(`walks ${name} to completion; dispatches and end-states match the trace`, async () => {
      const fx = JSON.parse(readFileSync(fixture(name), 'utf8')) as { entries: ITraceEntry[]; total_payout: number };
      const targets = new Map<string, RecordingTarget>([
        ['main_reels', new RecordingTarget()],
        ['bonus_meter', new RecordingTarget()],
      ]);
      const bus = createBus();
      const completes: unknown[] = [];
      bus.on('round:complete', (p) => completes.push(p));

      const walker = new TraceWalker({ bus, resolve: (id) => targets.get(id) ?? null });
      await walker.walk(fx.entries); // resolves without throwing = every entry is walkable

      // Every trigger reached the right module, in served order, with served data.
      const triggers = fx.entries.filter((e): e is Extract<ITraceEntry, { t: 'trigger' }> => e.t === 'trigger');
      expect(triggers.length).toBeGreaterThan(0);
      for (const [id, target] of targets) {
        const expected = triggers.filter((e) => e.mechanic === id);
        expect(target.calls).toEqual(expected.map((e) => ({ trigger: e.name, data: e.data })));
      }

      // Round completion carries the audited total.
      expect(completes).toEqual([{ total_payout: fx.total_payout }]);
      const end = fx.entries.at(-1);
      expect(end).toEqual({ t: 'round_end', total_payout: fx.total_payout });
    });
  }
});
```

- [ ] **Step 2: Run it**

Run: `npx nx test client`
Expected: PASS. If a fixture fails to parse or walk, that is a REAL mirror-type or walker bug — fix the client code (Tasks 1–2), never the fixture.

- [ ] **Step 3: Commit**

```bash
git add runtime/client/src/play/goldenWalk.spec.ts
git commit -m "test(runtime-client): golden-vector walk parity against kernel composed fixtures"
```

---

### Task 7: Composed e2e + full gates

**Files:**
- Modify: `runtime/client/playwright.config.ts`
- Modify: `runtime/client/e2e/start-server.cjs` (guard the mint step)
- Create: `runtime/client/e2e/playmode-composed.e2e.spec.ts`

**Interfaces:**
- Consumes: checked-in `runtime/server/demo/composed.pkg` (3×3 reels, meter target 6, ids `main_reels`/`bonus_meter`, symbols `0,1,2,9`); `BLOOM_RUNTIME_PORT` env (server `config.rs` reads it; final port = base + `BLOOM_PORT_OFFSET`); existing `e2e/start-server.cjs` (spawns `cargo run -p bloom-runtime-server` with the env Playwright passes; its demo-mint step is slots-only and harmless here).

- [ ] **Step 1: Add the composed server to `runtime/client/playwright.config.ts`**

After `const serverPort = 9000 + offset;` add:

```ts
const composedServerPort = 9100 + offset;
```

Append a third entry to the `webServer` array (same launcher, different package/port/audit):

```ts
    {
      // Second server instance serving the checked-in composed@1 demo package.
      command: 'node runtime/client/e2e/start-server.cjs',
      url: `http://localhost:${composedServerPort}/health`,
      cwd: '../../',
      reuseExistingServer: true,
      timeout: 240_000,
      env: {
        BLOOM_PORT_OFFSET: String(offset),
        BLOOM_RUNTIME_PORT: '9100',
        BLOOM_RUNTIME_PACKAGE: 'runtime/server/demo/composed.pkg',
        BLOOM_RUNTIME_AUDIT: 'runtime/server/var/audit.e2e-composed.jsonl',
      },
    },
```

Guard the mint step in `runtime/client/e2e/start-server.cjs` so the two launcher instances don't race to write `demo.pkg` on a cold start (fresh worktrees lack the git-ignored `demo.pkg`; `composed.pkg` is checked in and never minted here). Replace the `if (!existsSync(pkg)) {` line with:

```js
// Mint only when THIS instance serves the slots demo (composed.pkg is checked
// in); prevents the two webServer launchers racing to write demo.pkg cold.
const served = resolve(root, process.env.BLOOM_RUNTIME_PACKAGE || 'runtime/server/demo/demo.pkg');
if (served === pkg && !existsSync(pkg)) {
```

- [ ] **Step 2: Write the e2e spec**

`runtime/client/e2e/playmode-composed.e2e.spec.ts`:

```ts
// runtime/client/e2e/playmode-composed.e2e.spec.ts
import { test, expect } from '@playwright/test';

const offset = Number(process.env.BLOOM_PORT_OFFSET ?? 0) || 0;
const SERVER = `http://localhost:${9100 + offset}`;
const DEMO_SYMBOLS = ['0', '1', '2', '9'];

test('composed play-mode renders reels + meter from the handshake and walks a served trace', async ({ page }) => {
  await page.goto(`/?server=${encodeURIComponent(SERVER)}`);

  // Handshake built the scene from the definition's mechanics list: reels nodes
  // keyed by the mechanic instance id, and the meter bar (target 6 -> seg 0..5).
  await expect.poll(() => page.evaluate(() => (window as any).__engineModel?.toDocument().nodes['main_reels:reel:2'] != null), { timeout: 15000 }).toBe(true);
  expect(await page.evaluate(() => (window as any).__engineModel.toDocument().nodes['bonus_meter:seg:5'] != null)).toBe(true);

  await expect(page.locator('#spin')).toBeVisible();
  await page.click('#spin');

  // The button re-enables only when the whole walk settles (multi-state traces
  // replay several reel spins back to back — allow generous time).
  await expect(page.locator('#spin')).toBeEnabled({ timeout: 60000 });

  // Reels settled to a served 3x3 grid of package symbols; no error surfaced.
  const state = await page.evaluate(() => (window as any).__engineModules.state());
  expect(state.phase).toBe('idle');
  expect(state.grid.length).toBe(3);
  expect(state.grid.every((reel: string[]) => reel.length === 3)).toBe(true);
  expect(state.grid.flat().every((s: string) => DEMO_SYMBOLS.includes(s))).toBe(true);
  await expect(page.locator('#play-error')).toBeHidden();
});
```

- [ ] **Step 3: Run the runtime-client e2e suite (both servers boot; slots spec must stay green)**

From `runtime/client/` in the worktree, PowerShell:

```powershell
$env:BLOOM_PORT_OFFSET = '2'
npx playwright test
```

Expected: all specs pass (`playmode.e2e.spec.ts` against :9002, `playmode-composed.e2e.spec.ts` against :9102, client on :4302). First run compiles the Rust server — allow the 240s webServer timeout.

- [ ] **Step 4: Run the full frontend gates (repo CI parity)**

From the worktree root:

```powershell
node_modules/.bin/prettier --check .
npx nx run-many -t typecheck test build
```

Expected: prettier clean; typecheck/build green. Known pre-existing reds in an offset≠0 worktree: exactly 3 port-hardcoded `game-plugin` tests may fail — verify any failures are those three and nothing else.

- [ ] **Step 5: Run the studio e2e suite (repo rule: before every PR; engine.ts is shared with the studio-embedded client)**

Start the replay backend on this worktree's ports, then run the suite (worktree root):

```powershell
just backend-serve-replay   # backend on :8002 (leave running in its own shell)
just e2e                    # studio Playwright suite against :4202/:8002
```

Expected: green (baseline is 86 green per repo memory). If `just` can't find `sh` in your shell, run the underlying commands from the `justfile` recipes directly.

- [ ] **Step 6: Commit**

```bash
git add runtime/client/playwright.config.ts runtime/client/e2e/playmode-composed.e2e.spec.ts
git commit -m "test(runtime-client): composed play-mode e2e against the composed demo package"
```

---

### Task 8: Push + PR

- [ ] **Step 1: Final review of the branch diff**

```bash
git log --oneline main..HEAD
git diff main --stat
```

Confirm only the files in this plan's File Structure (plus the spec/plan docs) changed — in particular NOTHING under `trusted/math/fixtures/` or `runtime/server/`.

- [ ] **Step 2: Push and open the PR (repo default: push + PR, no options menu)**

```bash
git push -u origin feat/composed-sp3
gh pr create --title "feat(runtime-client): composed@1 trace playback (SP3)" --body "$(cat <<'EOF'
## Summary
- TS mirror types for the composed@1 GameDefinition/TraceEntry wire shapes (+ boundary validation)
- TraceWalker: steps the client through served lifecycle traces via an awaited module trigger seam
- MeterModule (meter@1) segment bar; ReelsModule gains the invoke('spin') trigger seam
- Play mode branches on the handshake mechanic: composed@1 builds module instances from the definition and walks traces; slots@1 path untouched
- Golden-vector parity suite over trusted/math/fixtures/composed; Playwright e2e against the checked-in composed demo package

Spec: docs/superpowers/specs/2026-07-09-composed-sp3-client-design.md (umbrella SP3, per #170/#174)

## Test plan
- [ ] npx nx test client (unit + golden vectors)
- [ ] npx nx run-many -t typecheck test build
- [ ] runtime/client Playwright suite with BLOOM_PORT_OFFSET=2 (slots + composed)
- [ ] just e2e (studio suite, replay backend)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Follow-up todos to file after merge (gh issues)

1. Per-state presentation variants driven by `state:enter`/`state:exit` bus events (spec §9.1).
2. Trace playback speed control (skip/turbo) for long free-spin traces (spec §9.2).

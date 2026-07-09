# Composed Games SP3: Client Trace Playback — Design

**Date:** 2026-07-09
**Status:** Approved design, pre-implementation
**Umbrella:** [2026-07-09-composed-games-mechanics-states-design.md](2026-07-09-composed-games-mechanics-states-design.md) (§7 is the normative source for this sub-project)
**Scope:** `runtime/client` plays a `composed@1` package end to end: TypeScript
mirror types, a TraceWalker that steps the client through the served trace,
`MeterModule`, definition-driven module instances, play mode against the
composed demo `.pkg`, golden-vector walk tests + Playwright e2e. Kernel (SP1,
#170) and package/server (SP2, #174) are merged; studio authoring (SP4) is out
of scope.

## 1. Goal

Direct play mode pointed at a runtime server serving `composed.pkg` renders
the demo game (reels + bonus meter), and a Spin walks the served lifecycle
trace with animation: reels settle to the served grids, the meter fills to the
served levels, states enter/exit on the bus, and the round completes with the
served total. `slots@1` play behavior is untouched.

## 2. Decisions locked during brainstorming

1. **Full umbrella-SP3 scope** — types, walker, meter, registration, play
   mode, golden vectors, e2e. Not a types-only slice.
2. **Slots stays on `Orchestrator`.** TraceWalker is composed-only; play mode
   branches on the handshake `mechanic`. Orchestrator retires only if slots
   ever emits traces. Zero slots regression surface, mirroring how SP2 kept
   slots wire output byte-identical.
3. **Meter is a segment bar of sprites** — `target` segments under the reels,
   `fill` of them lit (Sprite + tint, the `symbolColor` pattern). No new node
   types.
4. **Hand-written mirror types + typed invoke seam** (over ts-rs codegen and a
   bus-driven walker). Golden vectors are the drift alarm; the walker talks to
   modules through a small awaited interface, not stringly bus conventions.

## 3. Mirror types & wire (`play/composedTypes.ts`, `play/wireTypes.ts`)

Hand-written TS mirrors of the Rust wire shapes
(`trusted/math/src/mechanics/composed/{definition,trace}.rs`):

- `ITriggerData` — discriminated union on `kind`:
  `{ kind: 'reels'; grid: number[][]; payout: number }` |
  `{ kind: 'meter'; fill: number; target: number }`.
- `ITraceEntry` — discriminated union on `t`: `round_start { seed: string }`,
  `state_enter { state }`, `step { n }`,
  `trigger { mechanic, name, events: string[], data: ITriggerData }`,
  `transition { on, to?, effect? }`, `state_exit { state, payout: number }`,
  `round_end { total_payout: number }`.
- `IGameDefinition` + `IMechanicDecl { id, type, config: unknown }` plus the
  states/transitions/caps shapes. The client consumes only `family` and
  `mechanics`; the rest is carried for completeness and stays behaviorally
  opaque.

Numeric policy matches SP2: `seed` is a string (u64 can exceed 2^53); payouts
are bet-multiple u64s far below 2^53 and stay JSON numbers, same as slots.

`wireTypes.ts` grows what SP2 added to the wire:

- `IHandshakeResponse.definition?: unknown` (present for composed, absent for
  slots),
- `ISpinResponse.trace?: ITraceEntry[]` (same),
- `outcome: ISlotsOutcomeWire | IComposedOutcomeWire` where
  `IComposedOutcomeWire = { mechanic: string; total_payout: number }`.

A boundary guard `validateDefinition(unknown): IGameDefinition` mirrors
`validatePresentation`: checks `family === 'composed@1'` and the `mechanics`
array shape (id/type strings, config present), throws descriptive errors,
validates nothing deeper — the server already compiled the definition; the
client only needs the mechanics list.

## 4. TraceWalker (`orchestration/traceWalker.ts`)

Lives beside `Orchestrator` (untouched, still owns slots). Dependencies:

```ts
interface ITriggerTarget {
  invoke(trigger: string, data: ITriggerData): Promise<void>;
}
// deps: { bus: IEventBus; resolve: (mechanicId: string) => ITriggerTarget | null }
```

`walk(entries: ITraceEntry[]): Promise<void>` — strictly sequential over the
flat entry list:

| entry       | action                                                                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `trigger`   | resolve the module by `entry.mechanic` (the mechanic **instance id**); **await** `invoke(entry.name, entry.data)` before advancing. Unresolved mechanic → throw — the client is math-authoritative and fails loud; play mode surfaces the error. |
| `round_end` | emit `round:complete { total_payout }` — the event name the slots path already emits.                                                                                                                                                            |
| all others  | emit a bus event (`round:start`, `state:enter`, `state:exit`, `transition`, `step`) with the entry's payload and advance immediately. Bus events are v1's presentation hook (umbrella §7); per-state scene variants stay out of scope.           |

Re-entrance is prevented one level up (the Spin button stays disabled until
the walk promise settles), not inside the walker.

## 5. Modules

- **`ReelsModule` gains `invoke('spin', data)`** — asserts `data.kind ===
'reels'`, maps `grid: number[][]` to the module's `string[][]`, runs the
  existing project → startSpinning → stopSpinning sequence, and resolves on
  the next `reels:settled`. Unknown trigger name → reject. The
  Orchestrator/slots path through the module does not change.
- **New `MeterModule`** (`modules/meter/meterModule.ts`, registry type
  `meter`, config `{ target: number, parentId? }`): projects a horizontal row
  of `target` segment sprites under the reels — unlit tint vs lit tint, no new
  node types. `invoke('accumulate', data)` animates segments lighting up to
  the served `data.fill` (tick-driven, like reels motion), emits
  `meter:changed { fill, target }`, and resolves when the animation lands.
  Fill is server-authoritative: the module renders to `data.fill`, never
  counts symbols itself (the client never re-runs math).
- **Definition-driven instances.** `buildComposedPlayDocument(definition,
presentation, rootSize)` maps `definition.mechanics` to module declarations
  keyed by mechanic instance id (`main_reels`, `bonus_meter`):
  - `reels@1` → type `reels`, config from the presentation manifest
    (`toReelsConfig`, unchanged — presentation stays the visual source of
    truth),
  - `meter@1` → type `meter`, `{ target }` read from the mechanic config,
  - unknown mechanic type → loud error at the boundary.
- `engine.ts` registers the `meter` factory beside `reels`. The registry of
  available module **types** stays static; the module **instances** come from
  the definition, which is what umbrella §7 requires.
- `ModuleManager` gains `byId(id)` (the instances map is already keyed by id)
  so play mode's resolver for the walker is a one-line manager lookup.

## 6. Play mode & error handling (`play/playMode.ts`)

`startPlayMode` branches on `handshake.mechanic`:

- `slots@1` → today's path, byte-for-byte (Orchestrator, `reels:settled`
  re-enables the button).
- `composed@1` → `validateDefinition` + `validatePresentation` → init with the
  composed play document → Spin click runs `client.spin(1)` then
  `walker.walk(res.trace)`; the button re-enables when the walk promise
  settles (success or failure). A composed spin response without a `trace` is
  an error.
- any other mechanic → `showError`, no Spin button.

All failures (handshake, validation, missing trace, walk errors) route
through the existing `showError`. `runtimeClient.ts` needs no changes — the
JSON transport already carries the new optional fields.

## 7. Testing

TDD throughout (vitest); e2e is Playwright, local-only per repo CI policy.

- **Golden vectors — the parity contract (umbrella §7).** SP1 already checked
  in the shared fixtures at `trusted/math/fixtures/composed/` (proof-game
  definition + 4 pinned scenario traces: lose / fs1 / retrigger / fs2), whose
  header names the SP3 client as a consumer. The client suite reads them
  directly from that path (one source of truth, no copies to drift; changing
  a fixture is a re-certification event). Vitest, per trace fixture:
  1. parses definition + trace with the mirror types — the drift alarm: a
     kernel wire change that breaks the mirrors fails here first;
  2. walks the trace to completion with instrumented fake modules;
  3. asserts module end-states match the trace's claims — last reels trigger's
     grid, last meter trigger's fill, `round:complete` payload equal to the
     `round_end` total.
- **Unit:** composedTypes/`validateDefinition` (accept/reject shapes), walker
  (event order, awaits each trigger before advancing, unresolved mechanic
  throws, `round:complete` emission), `MeterModule` (projection idempotent,
  accumulate animates to fill and resolves, `meter:changed`),
  `ReelsModule.invoke` (settles to the served grid, resolves after
  `reels:settled`, bad kind/trigger rejects), document builder (mechanics →
  module decls, unknown type errors), play-mode branching (slots untouched,
  composed wires walker, unknown mechanic errors).
- **E2e:** a third `webServer` entry in `runtime/client/playwright.config.ts`
  boots the checked-in `runtime/server/demo/composed.pkg` on `9100 +
BLOOM_PORT_OFFSET` (the slots demo server keeps `9000 + offset`). New spec:
  load `?server=` the composed instance → reels grid **and** meter segments
  render from the handshake → click Spin → walk completes: reels phase idle
  with a served-shape grid, Spin button re-enabled. The existing slots
  playmode e2e stays green untouched. Run with the worktree's
  `BLOOM_PORT_OFFSET` per repo rules.

## 8. Out of scope (explicit)

- Per-state scene/presentation variants (different background in free spins)
  — v1's hook is the bus events.
- Interactive states / await-input trace entries (the walker's flat-sequence
  contract keeps the seam open; nothing consumes it).
- Composed curation/metrics/tooling convergence (filed follow-up from SP2).
- Studio authoring + build action (SP4).
- `slots@1` client changes of any kind.
- Skip/turbo playback controls for long traces (retriggered free spins walk at
  animation pace in v1; a fast-forward control is a named follow-up).

## 9. Follow-up todos to file

1. Per-state presentation variants driven by `state:enter`/`state:exit`.
2. Trace playback speed control (skip/turbo) for long free-spin traces.

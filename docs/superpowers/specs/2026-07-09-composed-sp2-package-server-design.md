# Composed Games SP2: Package Build + Server Dispatch — Design

**Date:** 2026-07-09
**Status:** Approved design, pre-implementation
**Umbrella:** [2026-07-09-composed-games-mechanics-states-design.md](2026-07-09-composed-games-mechanics-states-design.md) (§5 is the normative source for this sub-project)
**Scope:** Make `composed@1` games buildable into a signed `.pkg` and playable
through `bloom-runtime-server`. Kernel (SP1) is merged; client (SP3) and studio
(SP4) are out of scope here.

## 1. Goal

A `composed@1` Game Definition JSON can be built into a signed `.pkg`
(definition payload + uncurated seed pool + presentation), and
`bloom-runtime-server` loads it, dispatches `/spin` to the composed evaluator,
returns the lifecycle trace on the wire, and audits a replayable summary.
`slots@1` behavior is untouched.

## 2. Decisions locked during brainstorming

1. **Seed pool is uncurated in SP2**: `generate_seeds(master_seed, count)`
   (SplitMix64, same generator the simulator uses) — an honest random pool with
   no RTP guarantee. Composed curation/metrics is a filed follow-up todo
   (tooling convergence, umbrella §8/§10).
2. **Audit is summary-only**: `seed + definition_hash + total_payout` per round
   (umbrella §5). The full trace goes only on the `/spin` wire; replaying
   `evaluate(compile(definition), seed)` reproduces it bit-for-bit.
3. **Builder lives in `studio/simulator`** as a new `compose` bin — the crate
   already has `bloom-package`, dev signing, and `generate_seeds`, and the
   studio backend already shells out to this crate's binaries (`curate`,
   `tune_json`), so SP4's build action gets a ready-made subprocess target.

## 3. Kernel pre-work (`trusted/math`, folded-in follow-ups)

- **#165** — `eval.rs` budget `+= n` (two sites) becomes `saturating_add`
  (kernel must not be panicable by any input; a pathological `steps:add`
  effect could overflow `u32`).
- **#169** — re-export from `mechanics::composed`'s root what consumers need:
  `TriggerData`, plus (as SP2 itself consumes them) `RoundTrace`, `TraceEntry`,
  `GameDefinition`, `CompiledGame`, `compile`, `evaluate`, `to_payload`,
  `from_payload`. Payload-fn name collisions with `slots` are avoided by module
  path (`composed::from_payload`), same as today.

No behavior changes beyond the overflow guard. `composed@1` payload encoding
stays what SP1 shipped: JSON bytes via `composed::to_payload`/`from_payload`
(the umbrella said postcard; the merged source is JSON and is normative —
the payload is opaque to `bloom-package` either way).

## 4. Package builder — `studio/simulator`, new bin `compose`

```
compose <definition.json> <package_id> <seed_count> <master_seed> <out.pkg> [presentation.json]
```

Pipeline: read definition JSON → `composed::compile()` (all umbrella §3
validation; any `DefinitionError` prints and exits 2 — an invalid definition
never gets signed) → `generate_seeds(master_seed, seed_count)` →
`PackageContent { envelope: { package_id, package_version: 1, mechanic:
"composed@1" }, math_payload: composed::to_payload(&def), seeds, presentation }`
→ `bloom_package::build` with the fixed dev key (`[7u8; 32]`, same as `curate`;
real key management stays the deferred sign-off-gate concern).

The bin is a thin CLI over a library fn `build_composed_package(def, package_id,
seed_count, master_seed, presentation) -> Result<Vec<u8>, Vec<DefinitionError>>`
in `bloom-simulator`, so tests and the server integration suite build packages
without subprocesses. No report file: there are no measured metrics to report
(that's the curation follow-up); the CLI prints a one-line summary to stdout.

`bloom-simulator` gains no new deps (`bloom-math`, `bloom-package`,
`ed25519-dalek`, `serde_json` are all present).

## 5. Server — `bloom-runtime-server`

### 5.1 Load & dispatch (`state.rs`)

```rust
pub enum LoadedGame {
    Slots(SlotModel),
    Composed(CompiledGame),
}
```

`AppState.model: SlotModel` becomes `AppState.game: LoadedGame`, decoded by
matching `envelope.mechanic`:

- `"slots@1"` → `slots::from_payload` (unchanged path),
- `"composed@1"` → `composed::from_payload` then `composed::compile`; a
  decode or compile failure is a new loud `StartupError::BadDefinition`
  (umbrella §3: hard errors before any evaluation),
- anything else → new `StartupError::UnknownMechanic(String)`.

`AppState` also computes once at boot: `definition_hash: String` = lowercase
hex SHA-256 of `math_payload` (new dep: `sha2`). Computed
for **both** families — it is the hash of the payload, family-agnostic.

### 5.2 Wire (`wire.rs`)

- `OutcomeWire` gains a summary arm:

  ```rust
  #[serde(rename = "composed@1")]
  Composed { total_payout: u64 },
  ```

  Generic consumers keep reading `total_payout`. Per-state payouts live in the
  trace's `state_exit` entries; the summary does not duplicate them.

- `SpinResponse` gains `#[serde(skip_serializing_if = "Option::is_none")]
pub trace: Option<Vec<TraceEntry>>` — present for composed, absent for slots
  (slots wire output is byte-identical to today). `TraceEntry` already
  serializes wire-safely: the seed is a string (u64 > 2^53 lesson); payouts are
  bet-multiple u64s far below 2^53 and stay JSON numbers, matching slots.

- `HandshakeResponse` gains `#[serde(skip_serializing_if = "Option::is_none")]
pub definition: Option<serde_json::Value>` — the parsed Game Definition for
  composed packages, `None` for slots. SP2 owns the wire; SP3's client then
  never touches the server. (The payload is already JSON; this is
  `serde_json::from_slice` of `math_payload`.)

### 5.3 Spin (`routes.rs`)

`spin` matches `state.game`:

- **Slots**: exactly today's path.
- **Composed**: `evaluate(&game, seed)` → `RoundTrace`; respond
  `SpinResponse { seed, bet, outcome: Composed { total_payout }, trace:
Some(trace.entries) }`.

Audit-before-respond invariant is unchanged: a round that cannot be audited is
not served (500).

### 5.4 Audit (`audit.rs`)

`AuditRecord` gains `pub definition_hash: String`, written for both families
(one extra field per JSONL line; existing consumers are additive-tolerant —
verified by test). The composed `outcome` field is the summary arm only, so
composed audit = `seed + definition_hash + total_payout` per umbrella §5.
Replay: `evaluate(compile(from_payload(math_payload)), seed)` reproduces the
served trace.

`/health` and `/handshake` shapes are otherwise unchanged; `mechanic` in both
already reports the envelope string.

## 6. Demo package & proof

`runtime/server/demo/` gains:

- `composed.definition.json` — the umbrella's proof game: base (reels + meter)
  → fs1 (scatter-triggered, retrigger via `steps:add`) → fs2
  (meter-full-triggered), built on `reels@1` + `meter@1`.
- `composed.pkg` — built from it by the new `compose` CLI (checked in, like
  `demo.pkg`).
- `composed.presentation.json` — minimal manifest mirroring the slots demo's.

Proof of done: server boots `composed.pkg`; `/health` reports
`mechanic: "composed@1"`; `/spin` returns a trace that walks base→(fs1|fs2|end)
and whose replay from the audited seed matches; slots demo still serves
byte-identical responses.

## 7. Testing

TDD throughout; all Rust (CI-affordable, runs in CI per repo policy).

- **Kernel**: overflow-guard test for #165 (a definition whose `steps:add`
  would overflow the budget; round still terminates via `max_steps`).
- **Builder**: `build_composed_package` round-trips through
  `verify_and_load` + `composed::from_payload`; invalid definition returns the
  compile errors and signs nothing; seed pool is deterministic from
  `master_seed`; CLI exit codes (0 valid / 2 invalid or bad args).
- **Server unit** (`routes.rs`/`state.rs`/`wire.rs` mods): composed package
  boots; unknown mechanic and invalid definition fail startup with the right
  errors; `/spin` on composed returns string seed, summary outcome tagged
  `composed@1`, and a non-empty trace whose first/last entries are
  `round_start`/`round_end`; trace `total_payout` equals the summary's and the
  audit record's; slots responses carry **no** `trace` key and no behavior
  drift (existing tests stay green untouched); handshake carries the definition
  for composed and omits it for slots; audit line for composed contains
  `definition_hash` and no trace.
- **Server integration** (`tests/boot.rs` pattern): boot the checked-in
  `composed.pkg` end-to-end; replay determinism: re-evaluate the audited seed
  and assert the trace matches the served one.

## 8. Out of scope (explicit)

- Composed curation/metrics/tuning (filed todo — see §9).
- Client TraceWalker / play mode (SP3); studio authoring + build action (SP4).
- Interactive states, cross-round persistence, per-mechanic RNG streams
  (umbrella §10).
- Real signing-key management.
- `slots@1` changes of any kind.

## 9. Follow-up todos to file

1. **Composed curation/metrics**: measure/verify/freeze over `RoundTrace`
   (RTP from `total_payout`, hit-rates from state entries) so composed pools
   stop being uncurated — the architecture seam for tooling convergence.
2. Any further items surfaced during build.

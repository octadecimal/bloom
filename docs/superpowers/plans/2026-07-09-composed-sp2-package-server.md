# Composed SP2: Package Build + Server Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `composed@1` games buildable into a signed `.pkg` (via a new `compose` CLI in `bloom-simulator`) and playable through `bloom-runtime-server` (family dispatch, trace on the wire, summary-only audit).

**Architecture:** The kernel (SP1, merged) already compiles and evaluates `composed@1` definitions. This SP adds (1) a package builder that validates a definition and signs it with an uncurated SplitMix64 seed pool, and (2) server dispatch: `AppState` loads either family behind a `LoadedGame` enum, `/spin` returns the lifecycle trace for composed packages, `/handshake` carries the definition, and the audit records `seed + definition_hash + total_payout`. Spec: `docs/superpowers/specs/2026-07-09-composed-sp2-package-server-design.md`.

**Tech Stack:** Rust (workspace: `trusted/math`, `trusted/package`, `studio/simulator`, `runtime/server`), axum, serde_json, ed25519-dalek, sha2 (new dep, server only).

## Global Constraints

- Work in the worktree `C:\code\bloom.wt\composed-sp2`, branch `feat/composed-sp2`. All commands below run from that directory.
- CI gates (all must pass before every commit): `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo build --workspace`, `cargo test --workspace`. (`just fmt` / `just lint` wrap the first two.)
- Semantic (Conventional Commits) format for every commit.
- `slots@1` behavior and wire output must be **byte-identical** — no existing test may change its assertions (mechanical updates to construction syntax are fine; expected values never change).
- Any `u64` that can exceed 2^53 is string-encoded on the JSON wire. The seed already is; trace payouts are bet-multiples far below 2^53 and stay JSON numbers (matching slots).
- Only new dependency allowed: `sha2` in `runtime/server`.
- Windows gotchas: a cargo build-script failure with `os error 4551` means a stale App-Control-blocked artifact — `rm -rf target/*/build/<crate>-*` and rebuild. `--release` builds need WinLibs `dlltool` on `PATH`.
- Do not touch default ports (:8000/:4200/:4300) — another session may hold them; this worktree's `BLOOM_PORT_OFFSET` is in its `.env`.

---

### Task 1: Kernel pre-work — re-export `TriggerData` (#169); verify #165 already fixed

**Files:**

- Modify: `trusted/math/src/mechanics/composed/mod.rs`
- Modify: `trusted/math/src/mechanics/composed/trace.rs` (test import only)

**Interfaces:**

- Produces: `bloom_math::mechanics::composed::TriggerData` (re-export of `mechanic::TriggerData`). Later tasks import `TriggerData`, `TraceEntry`, `RoundTrace`, `GameDefinition`, `CompiledGame`, `compile`, `evaluate`, `to_payload`, `from_payload`, `DefinitionError`, `FAMILY` from `bloom_math::mechanics::composed` — all except `TriggerData` are already re-exported.

**Context:** Issue #165 (saturating budget add) is **already fixed** in merged SP1 — `eval.rs:80` and `eval.rs:124` both use `budget.saturating_add(n)` with explanatory comments, and the `supercritical_retrigger_stops_at_max_steps` / `exhausted_effect_row_refunds_budget_and_is_capped` tests cover the paths. No code change; the issue gets closed in Task 7.

- [ ] **Step 1: Write the failing "test" (an import through the re-export path)**

In `trusted/math/src/mechanics/composed/trace.rs`, inside `mod tests`, change the import (currently `use crate::mechanics::composed::mechanic::TriggerData;`) to:

```rust
use crate::mechanics::composed::TriggerData;
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p bloom-math composed::trace`
Expected: COMPILE ERROR — `no 'TriggerData' in 'mechanics::composed'`

- [ ] **Step 3: Add the re-export**

In `trusted/math/src/mechanics/composed/mod.rs`, extend the re-export block:

```rust
pub use compile::{compile, CompiledGame, DefinitionError};
pub use definition::{from_payload, to_payload, GameDefinition, FAMILY};
pub use eval::evaluate;
pub use mechanic::TriggerData;
pub use trace::{RoundTrace, TraceEntry};
```

(Only the `mechanic::TriggerData` line is new.)

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p bloom-math composed`
Expected: PASS (all composed tests green)

- [ ] **Step 5: Verify #165 is fixed on this branch**

Run: `grep -n "saturating_add" trusted/math/src/mechanics/composed/eval.rs`
Expected: two hits (the exhaustion branch and the in-step effect branch). If either site were a bare `+=`, this task would fix it — they are not.

- [ ] **Step 6: Gates + commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings && cargo test -p bloom-math
git add trusted/math/src/mechanics/composed/mod.rs trusted/math/src/mechanics/composed/trace.rs
git commit -m "feat(math): re-export TriggerData from mechanics::composed"
```

---

### Task 2: `build_composed_package` library fn in `bloom-simulator`

**Files:**

- Create: `studio/simulator/src/compose.rs`
- Modify: `studio/simulator/src/lib.rs`

**Interfaces:**

- Consumes: `bloom_math::mechanics::composed::{compile, to_payload, from_payload, DefinitionError, GameDefinition, FAMILY}`; `crate::seedgen::generate_seeds(master_seed: u64, count: usize) -> Vec<u64>`; `bloom_package::{build, Envelope, PackageContent}`.
- Produces: `bloom_simulator::compose::build_composed_package(def: &GameDefinition, package_id: &str, seed_count: usize, master_seed: u64, presentation: &[u8], signing_key: &SigningKey) -> Result<Vec<u8>, Vec<DefinitionError>>` — Task 3's CLI and (conceptually) SP4's build action call this.

- [ ] **Step 1: Write the failing tests**

Create `studio/simulator/src/compose.rs`:

```rust
//! Build + sign a `composed@1` package: definition → validate (kernel
//! `compile`) → uncurated seed pool → signed bytes. No curation/metrics —
//! composed curation is a filed follow-up (SP2 spec §2 decision 1). Pure
//! (no I/O); the `compose` bin does file handling.

use crate::seedgen::generate_seeds;
use bloom_math::mechanics::composed::{
    compile, to_payload, DefinitionError, GameDefinition, FAMILY,
};
use bloom_package::{build, Envelope, PackageContent};
use ed25519_dalek::SigningKey;

/// Validate the definition (any error means nothing is signed), then build
/// the signed package with a deterministic uncurated pool.
pub fn build_composed_package(
    def: &GameDefinition,
    package_id: &str,
    seed_count: usize,
    master_seed: u64,
    presentation: &[u8],
    signing_key: &SigningKey,
) -> Result<Vec<u8>, Vec<DefinitionError>> {
    compile(def)?;
    let content = PackageContent {
        envelope: Envelope {
            package_id: package_id.to_string(),
            package_version: 1,
            mechanic: FAMILY.to_string(),
        },
        math_payload: to_payload(def),
        seeds: generate_seeds(master_seed, seed_count),
        presentation: presentation.to_vec(),
    };
    Ok(build(&content, signing_key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use bloom_math::mechanics::composed::from_payload;
    use bloom_package::verify_and_load;
    use serde_json::json;

    fn key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    /// Minimal valid single-state definition (same shape as the kernel's own
    /// eval tests).
    fn valid_def() -> GameDefinition {
        serde_json::from_value(json!({
            "family": "composed@1",
            "mechanics": [
                { "id": "reels", "type": "reels@1",
                  "config": { "strips": [[0],[0],[0]], "rows": 1,
                              "symbols": [{"id":0,"role":"normal"}],
                              "paylines": [[0,0,0]],
                              "paytable": { "entries": [{"symbol":0,"count":3,"payout":5}] } } }
            ],
            "states": [
                { "id": "base",
                  "bindings": [ { "mechanic": "reels" } ],
                  "steps": { "budget": 1 },
                  "script": [ { "invoke": "reels.spin" } ] }
            ],
            "start": "base",
            "transitions": [],
            "caps": { "max_steps": 50 }
        }))
        .unwrap()
    }

    /// Parses as a GameDefinition but fails compile: `start` names an
    /// unknown state.
    fn invalid_def() -> GameDefinition {
        let mut v = serde_json::to_value(valid_def()).unwrap();
        v["start"] = json!("nope");
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn round_trips_through_verify_and_load() {
        let def = valid_def();
        let bytes =
            build_composed_package(&def, "pkg-composed", 100, 42, b"{\"p\":1}", &key()).unwrap();
        let content = verify_and_load(&bytes, &key().verifying_key()).unwrap();
        assert_eq!(content.envelope.mechanic, "composed@1");
        assert_eq!(content.envelope.package_id, "pkg-composed");
        assert_eq!(content.envelope.package_version, 1);
        assert_eq!(content.seeds, generate_seeds(42, 100));
        assert_eq!(content.presentation, b"{\"p\":1}");
        assert_eq!(from_payload(&content.math_payload).unwrap(), def);
    }

    #[test]
    fn invalid_definition_signs_nothing() {
        let err = build_composed_package(&invalid_def(), "pkg-bad", 100, 42, &[], &key());
        assert!(matches!(err, Err(ref e) if !e.is_empty()));
    }

    #[test]
    fn build_is_deterministic() {
        let def = valid_def();
        let a = build_composed_package(&def, "p", 50, 7, &[], &key()).unwrap();
        let b = build_composed_package(&def, "p", 50, 7, &[], &key()).unwrap();
        assert_eq!(a, b);
    }
}
```

Note: `round_trips_through_verify_and_load` asserts `from_payload(...) == def` — `GameDefinition` derives `PartialEq` in the merged SP1 source. If the compiler says otherwise, compare via `serde_json::to_value` on both sides instead; do not add derives to the frozen kernel type.

- [ ] **Step 2: Register the module and run tests to verify they fail**

In `studio/simulator/src/lib.rs` add `pub mod compose;` to the module list (alphabetical: after `curate`... it sorts first — put it before `curate`):

```rust
pub mod compose;
pub mod curate;
```

Run: `cargo test -p bloom-simulator compose`
Expected: the file above already contains the implementation, so tests should PASS on first run — TDD here is satisfied by writing tests and impl in one file; to honor red-green, comment out the `compile(def)?;` line, run, watch `invalid_definition_signs_nothing` FAIL, then restore it and watch all pass.

- [ ] **Step 3: Run the full simulator suite**

Run: `cargo test -p bloom-simulator`
Expected: PASS (existing curate/measure/target tests untouched and green)

- [ ] **Step 4: Gates + commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
git add studio/simulator/src/compose.rs studio/simulator/src/lib.rs
git commit -m "feat(simulator): build_composed_package — validated, signed composed@1 packages"
```

---

### Task 3: `compose` CLI bin

**Files:**

- Create: `studio/simulator/src/bin/compose.rs`

**Interfaces:**

- Consumes: `bloom_simulator::compose::build_composed_package` (Task 2 signature).
- Produces: CLI `compose <definition.json> <package_id> <seed_count> <master_seed> <out.pkg> [presentation.json]`; exit 0 on success, exit 2 on bad args or invalid definition. Task 6's justfile recipe and the demo package build call it.

- [ ] **Step 1: Write the bin**

Create `studio/simulator/src/bin/compose.rs`:

```rust
//! CLI: read a `composed@1` Game Definition JSON, validate it, and write the
//! dev-signed package with an uncurated deterministic seed pool.
//!
//! Usage: compose <definition.json> <package_id> <seed_count> <master_seed> <out.pkg> [presentation.json]
//!
//! NOTE: the demo signing key is fixed and for development only, same as
//! `curate`. Real signing keys are a sign-off-gate concern, out of scope.

use bloom_math::mechanics::composed::GameDefinition;
use bloom_simulator::compose::build_composed_package;
use ed25519_dalek::SigningKey;
use std::fs;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 6 && args.len() != 7 {
        eprintln!(
            "usage: compose <definition.json> <package_id> <seed_count> <master_seed> <out.pkg> [presentation.json]"
        );
        std::process::exit(2);
    }

    let def: GameDefinition =
        serde_json::from_str(&fs::read_to_string(&args[1]).expect("read definition"))
            .expect("parse definition");
    let seed_count: usize = args[3].parse().expect("seed_count must be an integer");
    let master_seed: u64 = args[4].parse().expect("master_seed must be a u64");
    let presentation: Vec<u8> = if args.len() == 7 {
        fs::read(&args[6]).expect("read presentation")
    } else {
        Vec::new()
    };

    let key = SigningKey::from_bytes(&[7u8; 32]);
    match build_composed_package(&def, &args[2], seed_count, master_seed, &presentation, &key) {
        Ok(bytes) => {
            fs::write(&args[5], &bytes).expect("write package");
            println!(
                "composed package written: {} ({} bytes, {} seeds, master_seed {})",
                args[5],
                bytes.len(),
                seed_count,
                master_seed
            );
        }
        Err(errors) => {
            eprintln!("invalid definition — nothing signed:");
            for e in &errors {
                eprintln!("  {e:?}");
            }
            std::process::exit(2);
        }
    }
}
```

- [ ] **Step 2: Smoke-test both exit paths**

```bash
mkdir -p target/tmp
cat > target/tmp/tiny.def.json <<'EOF'
{
  "family": "composed@1",
  "mechanics": [
    { "id": "reels", "type": "reels@1",
      "config": { "strips": [[0],[0],[0]], "rows": 1,
                  "symbols": [{"id":0,"role":"normal"}],
                  "paylines": [[0,0,0]],
                  "paytable": { "entries": [{"symbol":0,"count":3,"payout":5}] } } }
  ],
  "states": [
    { "id": "base", "bindings": [ { "mechanic": "reels" } ],
      "steps": { "budget": 1 }, "script": [ { "invoke": "reels.spin" } ] }
  ],
  "start": "base",
  "transitions": [],
  "caps": { "max_steps": 50 }
}
EOF
cargo run -p bloom-simulator --bin compose -- target/tmp/tiny.def.json pkg-smoke 100 42 target/tmp/smoke.pkg
echo "exit: $?"
```

Expected: `composed package written: target/tmp/smoke.pkg (... bytes, 100 seeds, master_seed 42)`, exit 0.

```bash
sed 's/"start": "base"/"start": "nope"/' target/tmp/tiny.def.json > target/tmp/bad.def.json
cargo run -p bloom-simulator --bin compose -- target/tmp/bad.def.json pkg-bad 100 42 target/tmp/bad.pkg
echo "exit: $?"
ls target/tmp/bad.pkg 2>/dev/null || echo "no package written (correct)"
```

Expected: `invalid definition — nothing signed:` + error lines, exit 2, no `bad.pkg` file.

- [ ] **Step 3: Gates + commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings && cargo build --workspace
git add studio/simulator/src/bin/compose.rs
git commit -m "feat(simulator): compose CLI — mint signed composed@1 packages"
```

---

### Task 4: Server wire types — `Composed` summary arm, `trace`, `definition`

**Files:**

- Modify: `runtime/server/src/wire.rs`
- Modify: `runtime/server/src/routes.rs` (construction sites only: `trace: None`, `definition: None`)

**Interfaces:**

- Consumes: `bloom_math::mechanics::composed::TraceEntry` (serde round-trip proven in SP1).
- Produces: `OutcomeWire::Composed { total_payout: u64 }` (serde tag `"composed@1"`); `SpinResponse.trace: Option<Vec<TraceEntry>>` (key omitted when `None`); `HandshakeResponse.definition: Option<serde_json::Value>` (key omitted when `None`). Task 5's dispatch fills them.

- [ ] **Step 1: Write the failing tests**

Append to `runtime/server/src/wire.rs` `mod tests`:

```rust
#[test]
fn composed_outcome_serializes_with_family_tag_and_summary() {
    let wire = OutcomeWire::Composed { total_payout: 640 };
    let json = serde_json::to_value(&wire).unwrap();
    assert_eq!(json["mechanic"], "composed@1");
    assert_eq!(json["total_payout"], 640);
    let back: OutcomeWire = serde_json::from_value(json).unwrap();
    assert_eq!(back, wire);
}

#[test]
fn spin_response_omits_trace_for_slots_and_carries_it_for_composed() {
    let outcome = OutcomeWire::from_round(&evaluate(&model_with_feature(), 53));
    let slots = SpinResponse {
        seed: 1,
        bet: 1,
        outcome: outcome.clone(),
        trace: None,
    };
    let v = serde_json::to_value(&slots).unwrap();
    assert!(
        v.get("trace").is_none(),
        "slots response must not have a trace key"
    );

    let composed = SpinResponse {
        seed: 1,
        bet: 1,
        outcome: OutcomeWire::Composed { total_payout: 0 },
        trace: Some(vec![bloom_math::mechanics::composed::TraceEntry::RoundEnd {
            total_payout: 0,
        }]),
    };
    let v = serde_json::to_value(&composed).unwrap();
    assert_eq!(v["trace"][0]["t"], "round_end");
}

#[test]
fn handshake_response_omits_definition_when_none() {
    let none = HandshakeResponse {
        package_id: "p".into(),
        package_version: 1,
        mechanic: "slots@1".into(),
        presentation: serde_json::Value::Null,
        definition: None,
    };
    let v = serde_json::to_value(&none).unwrap();
    assert!(v.get("definition").is_none());

    let some = HandshakeResponse {
        package_id: "p".into(),
        package_version: 1,
        mechanic: "composed@1".into(),
        presentation: serde_json::Value::Null,
        definition: Some(serde_json::json!({"family": "composed@1"})),
    };
    let v = serde_json::to_value(&some).unwrap();
    assert_eq!(v["definition"]["family"], "composed@1");
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p bloom-runtime-server wire`
Expected: COMPILE ERROR — no variant `Composed`, no field `trace`, no field `definition`.

- [ ] **Step 3: Implement the wire additions**

In `runtime/server/src/wire.rs`:

Add the import:

```rust
use bloom_math::mechanics::composed::TraceEntry;
```

Extend `OutcomeWire`:

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mechanic")]
pub enum OutcomeWire {
    #[serde(rename = "slots@1")]
    Slots(SlotsOutcomeWire),
    /// Summary arm: generic consumers read `total_payout`; per-state payouts
    /// live in the trace's `state_exit` entries (SP2 spec §5.2).
    #[serde(rename = "composed@1")]
    Composed { total_payout: u64 },
}
```

Extend `SpinResponse`:

```rust
#[derive(Debug, Serialize)]
pub struct SpinResponse {
    #[serde(serialize_with = "serialize_seed_as_string")]
    pub seed: u64,
    pub bet: u64,
    pub outcome: OutcomeWire,
    /// The full lifecycle trace — composed packages only. Slots responses
    /// are byte-identical to pre-SP2 (key omitted).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace: Option<Vec<TraceEntry>>,
}
```

Extend `HandshakeResponse`:

```rust
#[derive(Debug, Serialize)]
pub struct HandshakeResponse {
    pub package_id: String,
    pub package_version: u32,
    pub mechanic: String,
    pub presentation: serde_json::Value,
    /// The parsed Game Definition — composed packages only (SP3's client
    /// builds its module set from this; SP2 spec §5.2).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub definition: Option<serde_json::Value>,
}
```

Fix the now-refutable pattern in the existing `maps_round_outcome_faithfully` test:

```rust
let OutcomeWire::Slots(s) = &wire else {
    panic!("expected the slots arm")
};
```

Fix the existing `spin_response_serializes_seed_as_a_string` test's constructor (add `trace: None`).

In `runtime/server/src/routes.rs`, update the two construction sites so the crate compiles (dispatch comes in Task 5):

- `handshake`: add `definition: None,` to the `HandshakeResponse { ... }` literal.
- `spin`: add `trace: None,` to the `SpinResponse { ... }` literal.

- [ ] **Step 4: Run to verify everything passes**

Run: `cargo test -p bloom-runtime-server`
Expected: PASS — new wire tests green, all existing route/state/boot tests untouched and green.

- [ ] **Step 5: Gates + commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
git add runtime/server/src/wire.rs runtime/server/src/routes.rs
git commit -m "feat(runtime-server): composed@1 wire types — summary outcome, trace, handshake definition"
```

---

### Task 5: Server load + dispatch + audit hash

**Files:**

- Modify: `runtime/server/Cargo.toml` (add `sha2 = "0.10"`)
- Modify: `runtime/server/src/state.rs`
- Modify: `runtime/server/src/routes.rs`
- Modify: `runtime/server/src/audit.rs`

**Interfaces:**

- Consumes: `bloom_math::mechanics::composed::{self, CompiledGame, compile, evaluate, from_payload}`; Task 4's wire fields.
- Produces:
  - `pub enum LoadedGame { Slots(SlotModel), Composed(CompiledGame) }` (in `state.rs`),
  - `AppState { package, game: LoadedGame, definition_hash: String, draw, audit }` (field `model` is **replaced** by `game`),
  - `pub fn payload_hash(bytes: &[u8]) -> String` (lowercase-hex SHA-256, in `state.rs`),
  - `StartupError::{BadDefinition(String), UnknownMechanic(String)}` new variants,
  - `AuditRecord.definition_hash: String` (`#[serde(default)]`),
  - `/spin` and `/handshake` dispatch on `state.game`. Task 6's integration tests rely on all of these.

- [ ] **Step 1: Write the failing tests**

Append to `runtime/server/src/state.rs` `mod tests`:

```rust
use serde_json::json;

fn tiny_composed_def_json() -> serde_json::Value {
    json!({
        "family": "composed@1",
        "mechanics": [
            { "id": "reels", "type": "reels@1",
              "config": { "strips": [[0],[0],[0]], "rows": 1,
                          "symbols": [{"id":0,"role":"normal"}],
                          "paylines": [[0,0,0]],
                          "paytable": { "entries": [{"symbol":0,"count":3,"payout":5}] } } }
        ],
        "states": [
            { "id": "base", "bindings": [ { "mechanic": "reels" } ],
              "steps": { "budget": 1 }, "script": [ { "invoke": "reels.spin" } ] }
        ],
        "start": "base",
        "transitions": [],
        "caps": { "max_steps": 50 }
    })
}

fn composed_package_bytes(def_json: &serde_json::Value, mechanic: &str) -> Vec<u8> {
    let content = PackageContent {
        envelope: Envelope {
            package_id: "pkg-composed-test".into(),
            package_version: 1,
            mechanic: mechanic.into(),
        },
        math_payload: serde_json::to_vec(def_json).unwrap(),
        seeds: vec![1, 2, 3],
        presentation: Vec::new(),
    };
    build(&content, &dev_signing_key())
}

#[test]
fn loads_and_compiles_a_composed_package() {
    let bytes = composed_package_bytes(&tiny_composed_def_json(), "composed@1");
    let state = AppState::from_package_bytes(
        &bytes,
        Box::new(crate::draw::OsRngDraw),
        Box::new(crate::audit::MemoryAuditSink::new()),
    )
    .expect("composed package loads");
    assert!(matches!(state.game, LoadedGame::Composed(_)));
    assert_eq!(state.definition_hash.len(), 64);
    assert!(state.definition_hash.chars().all(|c| c.is_ascii_hexdigit()));
}

#[test]
fn rejects_an_unknown_mechanic_family() {
    let bytes = composed_package_bytes(&tiny_composed_def_json(), "mystery@9");
    assert!(matches!(
        AppState::from_package_bytes(
            &bytes,
            Box::new(crate::draw::OsRngDraw),
            Box::new(crate::audit::MemoryAuditSink::new()),
        ),
        Err(StartupError::UnknownMechanic(m)) if m == "mystery@9"
    ));
}

#[test]
fn rejects_a_composed_package_with_an_invalid_definition() {
    let mut def = tiny_composed_def_json();
    def["start"] = json!("nope");
    let bytes = composed_package_bytes(&def, "composed@1");
    assert!(matches!(
        AppState::from_package_bytes(
            &bytes,
            Box::new(crate::draw::OsRngDraw),
            Box::new(crate::audit::MemoryAuditSink::new()),
        ),
        Err(StartupError::BadDefinition(_))
    ));
}

#[test]
fn payload_hash_matches_the_sha256_test_vector() {
    // SHA-256("abc") — FIPS 180-2 appendix B.1.
    assert_eq!(
        payload_hash(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}
```

Append to `runtime/server/src/routes.rs` `mod tests`:

```rust
use crate::state::LoadedGame;

fn composed_def_json() -> serde_json::Value {
    serde_json::json!({
        "family": "composed@1",
        "mechanics": [
            { "id": "reels", "type": "reels@1",
              "config": { "strips": [[0],[0],[0]], "rows": 1,
                          "symbols": [{"id":0,"role":"normal"}],
                          "paylines": [[0,0,0]],
                          "paytable": { "entries": [{"symbol":0,"count":3,"payout":5}] } } }
        ],
        "states": [
            { "id": "base", "bindings": [ { "mechanic": "reels" } ],
              "steps": { "budget": 1 }, "script": [ { "invoke": "reels.spin" } ] }
        ],
        "start": "base",
        "transitions": [],
        "caps": { "max_steps": 50 }
    })
}

/// Composed state with a shared audit handle, mirroring `spin_state`.
fn composed_spin_state() -> (Arc<AppState>, Arc<MemoryAuditSink>) {
    let content = PackageContent {
        envelope: Envelope {
            package_id: "pkg-composed-spin".into(),
            package_version: 1,
            mechanic: "composed@1".into(),
        },
        math_payload: serde_json::to_vec(&composed_def_json()).unwrap(),
        seeds: vec![11, 22, 33],
        presentation: Vec::new(),
    };
    let bytes = build(&content, &SigningKey::from_bytes(&[7u8; 32]));
    let audit = Arc::new(MemoryAuditSink::new());
    struct Shared(Arc<MemoryAuditSink>);
    impl crate::audit::AuditSink for Shared {
        fn append(&self, rec: &crate::audit::AuditRecord) -> std::io::Result<()> {
            self.0.append(rec)
        }
    }
    let state = AppState::from_package_bytes(
        &bytes,
        Box::new(FixedDraw { index: 0 }),
        Box::new(Shared(audit.clone())),
    )
    .unwrap();
    (Arc::new(state), audit)
}

#[tokio::test]
async fn composed_spin_returns_summary_outcome_and_walkable_trace() {
    let (state, audit) = composed_spin_state(); // draws seeds[0] == 11
    let app = build_app(state);
    let (status, v) = post_spin(app, "{}").await;
    assert_eq!(status, 200);
    assert_eq!(v["seed"], "11");
    assert_eq!(v["outcome"]["mechanic"], "composed@1");
    // Forced single-symbol strips: one base step always pays 5.
    assert_eq!(v["outcome"]["total_payout"], 5);
    let trace = v["trace"].as_array().expect("composed spin carries a trace");
    assert_eq!(trace.first().unwrap()["t"], "round_start");
    assert_eq!(trace.first().unwrap()["seed"], "11");
    assert_eq!(trace.last().unwrap()["t"], "round_end");
    assert_eq!(trace.last().unwrap()["total_payout"], 5);
    // Audit: summary-only (the record has no trace anywhere) + the hash.
    let recs = audit.records();
    assert_eq!(recs.len(), 1);
    assert_eq!(recs[0].seed, 11);
    assert_eq!(recs[0].definition_hash.len(), 64);
    assert_eq!(
        recs[0].outcome,
        OutcomeWire::Composed { total_payout: 5 }
    );
    let audit_json = serde_json::to_value(&recs[0]).unwrap();
    assert!(audit_json.get("trace").is_none());
    assert!(audit_json["outcome"].get("trace").is_none());
}

#[tokio::test]
async fn slots_spin_response_has_no_trace_key_and_records_the_hash() {
    let (state, audit) = spin_state(0);
    let app = build_app(state);
    let (status, v) = post_spin(app, "{}").await;
    assert_eq!(status, 200);
    assert!(v.get("trace").is_none(), "slots wire must not grow a trace key");
    assert_eq!(audit.records()[0].definition_hash.len(), 64);
}

#[tokio::test]
async fn composed_handshake_carries_the_definition_and_slots_does_not() {
    let (state, _audit) = composed_spin_state();
    let (status, v) = get_json(build_app(state), "/handshake").await;
    assert_eq!(status, 200);
    assert_eq!(v["mechanic"], "composed@1");
    assert_eq!(v["definition"]["family"], "composed@1");
    assert_eq!(v["definition"]["start"], "base");

    let slots_app = build_app(state_with_presentation(b""));
    let (status, v) = get_json(slots_app, "/handshake").await;
    assert_eq!(status, 200);
    assert!(v.get("definition").is_none());
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p bloom-runtime-server`
Expected: COMPILE ERROR — `LoadedGame`, `payload_hash`, `definition_hash`, `UnknownMechanic`, `BadDefinition` don't exist.

- [ ] **Step 3: Implement**

`runtime/server/Cargo.toml` — add to `[dependencies]`:

```toml
sha2 = "0.10"
```

`runtime/server/src/state.rs` — replace the model field with family dispatch:

```rust
use crate::audit::AuditSink;
use crate::draw::Draw;
use bloom_math::mechanics::composed;
use bloom_math::mechanics::slots::{from_payload, SlotModel};
use bloom_package::{verify_and_load, PackageContent, PackageError};
use ed25519_dalek::{SigningKey, VerifyingKey};
use sha2::{Digest, Sha256};

#[derive(Debug)]
pub enum StartupError {
    BadPackage(PackageError),
    BadPayload(postcard::Error),
    /// Composed payload failed to parse or compile (umbrella §3: hard errors
    /// before any evaluation).
    BadDefinition(String),
    UnknownMechanic(String),
    Io(std::io::Error),
    EmptyPool,
}

/// The decoded, family-dispatched math artifact.
pub enum LoadedGame {
    Slots(SlotModel),
    Composed(composed::CompiledGame),
}

/// Lowercase-hex SHA-256 of the math payload — the audit's `definition_hash`
/// (SP2 spec §5.4). Family-agnostic: it hashes whatever bytes are signed.
pub fn payload_hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub struct AppState {
    pub package: PackageContent,
    pub game: LoadedGame,
    pub definition_hash: String,
    pub draw: Box<dyn Draw>,
    pub audit: Box<dyn AuditSink>,
}
```

and in `from_package_bytes`, replace the `let model = ...` line with:

```rust
let game = match package.envelope.mechanic.as_str() {
    "slots@1" => LoadedGame::Slots(
        from_payload(&package.math_payload).map_err(StartupError::BadPayload)?,
    ),
    "composed@1" => {
        let def = composed::from_payload(&package.math_payload)
            .map_err(|e| StartupError::BadDefinition(e.to_string()))?;
        let compiled = composed::compile(&def)
            .map_err(|errs| StartupError::BadDefinition(format!("{errs:?}")))?;
        LoadedGame::Composed(compiled)
    }
    other => return Err(StartupError::UnknownMechanic(other.to_string())),
};
let definition_hash = payload_hash(&package.math_payload);
```

and construct `AppState { package, game, definition_hash, draw, audit }`. (Order matters: read `package.math_payload` before moving `package` into the struct.)

Update the existing state test `loads_and_decodes_a_valid_package`:

```rust
assert!(matches!(&state.game, LoadedGame::Slots(m) if m.reels.len() == 3));
```

`runtime/server/src/audit.rs` — add to `AuditRecord` (after `math_engine_version`):

```rust
/// SHA-256 (lowercase hex) of the signed math payload. `default` keeps
/// pre-SP2 JSONL lines deserializable.
#[serde(default)]
pub definition_hash: String,
```

`runtime/server/src/routes.rs` — dispatch. Change the import line to:

```rust
use crate::state::{AppState, LoadedGame};
```

(keep `use bloom_math::mechanics::slots::evaluate;`). In `handshake`, replace `definition: None,` with:

```rust
definition: match &state.game {
    LoadedGame::Composed(_) => serde_json::from_slice(&state.package.math_payload).ok(),
    LoadedGame::Slots(_) => None,
},
```

In `spin`, replace the outcome line with:

```rust
let (outcome, trace) = match &state.game {
    LoadedGame::Slots(model) => (OutcomeWire::from_round(&evaluate(model, seed)), None),
    LoadedGame::Composed(game) => {
        let t = bloom_math::mechanics::composed::evaluate(game, seed);
        (
            OutcomeWire::Composed {
                total_payout: t.total_payout,
            },
            Some(t.entries),
        )
    }
};
```

add `definition_hash: state.definition_hash.clone(),` to the `AuditRecord { ... }` literal, and end with:

```rust
Ok(Json(SpinResponse {
    seed,
    bet,
    outcome,
    trace,
}))
```

Update the two existing routes tests that read `state.model.clone()` (`spin_returns_authoritative_reproducible_outcome`, `spin_appends_one_audit_record_that_reproduces`) with a test helper added to `mod tests`:

```rust
fn slots_model(state: &AppState) -> SlotModel {
    match &state.game {
        LoadedGame::Slots(m) => m.clone(),
        _ => panic!("test state is slots"),
    }
}
```

and `let model = slots_model(&state);` at both call sites.

- [ ] **Step 4: Run to verify everything passes**

Run: `cargo test -p bloom-runtime-server`
Expected: PASS — all new tests green; every pre-existing test green with unchanged expected values (`boot.rs` included).

Note: if clippy flags `large_enum_variant` on `LoadedGame`, box the larger arm (`Composed(Box<composed::CompiledGame>)`) and adjust the two construction/match sites — do not `#[allow]`.

- [ ] **Step 5: Gates + commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
git add runtime/server/Cargo.toml runtime/server/src/state.rs runtime/server/src/routes.rs runtime/server/src/audit.rs Cargo.lock
git commit -m "feat(runtime-server): composed@1 dispatch — LoadedGame, trace wire, definition_hash audit"
```

---

### Task 6: Composed demo package + integration proof

**Files:**

- Create: `runtime/server/demo/composed.definition.json`
- Create: `runtime/server/demo/composed.presentation.json`
- Create: `runtime/server/demo/composed.pkg` (minted by the CLI, checked in like `demo.pkg`)
- Create: `runtime/server/tests/composed.rs`
- Modify: `justfile` (two recipes)

**Interfaces:**

- Consumes: `compose` CLI (Task 3), `LoadedGame`/dispatch (Task 5), `bloom_math::mechanics::composed::{compile, evaluate, GameDefinition}`.
- Produces: the checked-in proof artifacts and `just composed-demo-pkg` / `just runtime-serve-composed` recipes; SP3 will point the client at this package.

- [ ] **Step 1: Write the demo definition**

Create `runtime/server/demo/composed.definition.json` — the umbrella's proof game (base [reels+meter] → fs1 [scatter-triggered, retriggers] → fs2 [meter-full-triggered]):

```json
{
  "family": "composed@1",
  "mechanics": [
    {
      "id": "main_reels",
      "type": "reels@1",
      "config": {
        "strips": [
          [0, 1, 2, 0, 9, 1, 0, 2, 1, 0],
          [1, 0, 2, 9, 0, 1, 2, 0, 0, 1],
          [2, 1, 0, 0, 1, 9, 0, 2, 1, 0]
        ],
        "rows": 3,
        "symbols": [
          { "id": 0, "role": "normal" },
          { "id": 1, "role": "normal" },
          { "id": 2, "role": "normal" },
          { "id": 9, "role": "scatter" }
        ],
        "paylines": [
          [0, 0, 0],
          [1, 1, 1],
          [2, 2, 2]
        ],
        "paytable": {
          "entries": [
            { "symbol": 0, "count": 3, "payout": 5 },
            { "symbol": 1, "count": 3, "payout": 10 },
            { "symbol": 2, "count": 3, "payout": 20 },
            { "symbol": 9, "count": 3, "payout": 2 }
          ]
        },
        "events": [{ "symbol": 9, "min_count": 3, "emit": "scatters:3" }]
      }
    },
    {
      "id": "bonus_meter",
      "type": "meter@1",
      "config": { "target": 6, "count_symbol": 9, "reset_on_full": true }
    }
  ],
  "states": [
    {
      "id": "base",
      "bindings": [{ "mechanic": "main_reels" }, { "mechanic": "bonus_meter" }],
      "steps": { "budget": 1 },
      "script": [{ "invoke": "main_reels.spin" }, { "invoke": "bonus_meter.accumulate" }]
    },
    {
      "id": "fs1",
      "bindings": [{ "mechanic": "main_reels", "override": { "multiplier": 2 } }, { "mechanic": "bonus_meter" }],
      "steps": { "budget": "awarded", "initial": 8 },
      "script": [{ "invoke": "main_reels.spin" }, { "invoke": "bonus_meter.accumulate" }]
    },
    {
      "id": "fs2",
      "bindings": [{ "mechanic": "main_reels", "override": { "multiplier": 3 } }],
      "steps": { "budget": 5 },
      "script": [{ "invoke": "main_reels.spin" }]
    }
  ],
  "start": "base",
  "transitions": [
    { "from": "base", "on": "scatters:3", "to": "fs1" },
    { "from": "base", "on": "meter:full", "to": "fs2" },
    { "from": "fs1", "on": "scatters:3", "effect": "steps:add:8" },
    { "from": "fs1", "on": "meter:full", "to": "fs2" }
  ],
  "caps": { "max_steps": 1000 }
}
```

Create `runtime/server/demo/composed.presentation.json` (minimal manifest, mirroring the slots demo's shape; SP3 defines real consumption):

```json
{
  "parentId": "root",
  "cols": 3,
  "rows": 3,
  "symbols": ["0", "1", "2", "9"]
}
```

- [ ] **Step 2: Add the justfile recipes and mint the package**

In `justfile`, directly below the `runtime-serve` recipe, add (match the file's existing indentation/continuation style):

```make
# Mint the composed@1 demo package (dev-signed, uncurated pool) from its fixture.
composed-demo-pkg:
    cargo run --release -p bloom-simulator --bin compose -- \
      runtime/server/demo/composed.definition.json \
      bloom-demo-composed 10000 20260709 \
      runtime/server/demo/composed.pkg \
      runtime/server/demo/composed.presentation.json

# Run the authoritative runtime game server on the composed demo package.
runtime-serve-composed: composed-demo-pkg
    BLOOM_RUNTIME_PACKAGE=runtime/server/demo/composed.pkg cargo run --release -p bloom-runtime-server
```

Run: `just composed-demo-pkg`
Expected: `composed package written: runtime/server/demo/composed.pkg (... bytes, 10000 seeds, master_seed 20260709)`. (If the release build fails on `dlltool`/`os error 4551`, see Global Constraints.)

- [ ] **Step 3: Write the failing integration tests**

Create `runtime/server/tests/composed.rs`:

```rust
//! Composed demo package end-to-end: boot the committed fixture through the
//! real router, and prove the served trace replays bit-for-bit from the
//! audited seed (SP2 spec §6). Builds the package in-process from the
//! committed definition (like boot.rs), and separately asserts the
//! CLI-minted, checked-in composed.pkg loads.

use bloom_math::mechanics::composed::{compile, evaluate, GameDefinition};
use bloom_package::{build, Envelope, PackageContent};
use bloom_runtime_server::build_app;
use bloom_runtime_server::state::{AppState, LoadedGame};
use ed25519_dalek::SigningKey;
use std::sync::Arc;
use tower::ServiceExt;

fn demo_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/demo"))
}

fn demo_definition() -> GameDefinition {
    let json = std::fs::read_to_string(demo_dir().join("composed.definition.json"))
        .expect("read composed.definition.json");
    serde_json::from_str(&json).expect("parse composed.definition.json")
}

/// In-process package from the committed fixtures (mirrors boot.rs: no
/// pre-step needed; reading the fixtures also asserts they parse).
fn composed_package_bytes() -> Vec<u8> {
    let def = demo_definition();
    let presentation = std::fs::read(demo_dir().join("composed.presentation.json"))
        .expect("read composed.presentation.json");
    let content = PackageContent {
        envelope: Envelope {
            package_id: "bloom-demo-composed".to_string(),
            package_version: 1,
            mechanic: "composed@1".to_string(),
        },
        math_payload: bloom_math::mechanics::composed::to_payload(&def),
        seeds: (0..1000u64).collect(),
        presentation,
    };
    build(&content, &SigningKey::from_bytes(&[7u8; 32]))
}

fn composed_state() -> Arc<AppState> {
    Arc::new(
        AppState::from_package_bytes(
            &composed_package_bytes(),
            Box::new(bloom_runtime_server::draw::OsRngDraw),
            Box::new(bloom_runtime_server::audit::MemoryAuditSink::new()),
        )
        .unwrap(),
    )
}

async fn get(app: axum::Router, uri: &str) -> serde_json::Value {
    let resp = app
        .oneshot(
            axum::http::Request::builder()
                .uri(uri)
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn composed_demo_boots_and_health_reports_the_family() {
    let v = get(build_app(composed_state()), "/health").await;
    assert_eq!(v["status"], "ok");
    assert_eq!(v["package_id"], "bloom-demo-composed");
    assert_eq!(v["mechanic"], "composed@1");
}

#[tokio::test]
async fn composed_demo_handshake_carries_presentation_and_definition() {
    let v = get(build_app(composed_state()), "/handshake").await;
    assert_eq!(v["presentation"]["cols"], 3);
    assert_eq!(v["definition"]["family"], "composed@1");
    assert_eq!(v["definition"]["start"], "base");
    assert_eq!(v["definition"]["states"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn composed_demo_spin_trace_replays_bit_for_bit() {
    let app = build_app(composed_state());
    let resp = app
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/spin")
                .header("content-type", "application/json")
                .body(axum::body::Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();

    // Walkable: starts with round_start, ends with round_end.
    let trace = v["trace"].as_array().expect("composed spin carries a trace");
    assert_eq!(trace.first().unwrap()["t"], "round_start");
    assert_eq!(trace.last().unwrap()["t"], "round_end");

    // Replay: re-evaluate the served (string-encoded) seed; the trace and
    // summary must match exactly — the audit-reproducibility guarantee.
    let seed: u64 = v["seed"].as_str().expect("seed is a string").parse().unwrap();
    let compiled = compile(&demo_definition()).expect("demo definition compiles");
    let expected = evaluate(&compiled, seed);
    assert_eq!(
        v["trace"],
        serde_json::to_value(&expected.entries).unwrap()
    );
    assert_eq!(v["outcome"]["mechanic"], "composed@1");
    assert_eq!(v["outcome"]["total_payout"], expected.total_payout);
}

#[tokio::test]
async fn checked_in_composed_pkg_loads_and_is_composed() {
    let bytes =
        std::fs::read(demo_dir().join("composed.pkg")).expect("read checked-in composed.pkg");
    let state = AppState::from_package_bytes(
        &bytes,
        Box::new(bloom_runtime_server::draw::OsRngDraw),
        Box::new(bloom_runtime_server::audit::MemoryAuditSink::new()),
    )
    .expect("checked-in composed.pkg verifies and compiles");
    assert_eq!(state.package.envelope.package_id, "bloom-demo-composed");
    assert_eq!(state.package.seeds.len(), 10000);
    assert!(matches!(state.game, LoadedGame::Composed(_)));
}
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `cargo test -p bloom-runtime-server --test composed`
Expected: PASS (4 tests). These fail only if Tasks 3–5 or the fixtures are wrong — if `composed_demo_spin_trace_replays_bit_for_bit` fails, the definition or dispatch is broken; debug there, do not weaken the assertion.

- [ ] **Step 5: Manual live proof**

```bash
just runtime-serve-composed
```

Expected: `runtime/server listening on 0.0.0.0:9002` (9000 + this worktree's `BLOOM_PORT_OFFSET`; check `.env`). In a second shell (substitute the real port):

```bash
curl -s http://localhost:9002/health
curl -s -X POST http://localhost:9002/spin -H "content-type: application/json" -d '{"bet":1}'
```

Expected: health shows `"mechanic":"composed@1"`; spin returns `seed` (string), `outcome` tagged `composed@1`, and a `trace` array. Spin a few times — most rounds are base-only (6 trace entries); occasionally `scatters:3` chains into fs1. Kill the server after.

- [ ] **Step 6: Gates + commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
git add runtime/server/demo/composed.definition.json runtime/server/demo/composed.presentation.json runtime/server/demo/composed.pkg runtime/server/tests/composed.rs justfile
git commit -m "feat(runtime-server): composed demo package + end-to-end replay proof"
```

---

### Task 7: Follow-up todos, issue hygiene, final gates

**Files:**

- None (gh + verification only)

- [ ] **Step 1: File the follow-up todo (from brainstorming decision 1)**

```bash
gh issue create --label todo --assignee @me \
  --title "composed@1: curation/metrics for composed packages" \
  --body "SP2 ships composed .pkg seed pools UNCURATED (generate_seeds only, no RTP/vol verification) — decided in docs/superpowers/specs/2026-07-09-composed-sp2-package-server-design.md §2. Follow-up: measure/verify/freeze over RoundTrace (RTP from total_payout, hit rates from state_enter entries), the seam for tuner/simulator/analytics convergence on composed games (umbrella spec §8/§10)."
```

- [ ] **Step 2: Close the stale kernel issue**

#165 (saturating budget add) was already fixed in merged SP1 (`eval.rs:80`, `eval.rs:124` — verified in Task 1):

```bash
gh issue close 165 --comment "Already fixed in the merged SP1 (PR #170): both budget-add sites in composed/eval.rs use saturating_add, covered by supercritical_retrigger_stops_at_max_steps and exhausted_effect_row_refunds_budget_and_is_capped. Verified during SP2 Task 1."
```

(#169 is fixed by Task 1 on this branch — do **not** close it manually; the PR body's `Closes #169` handles it at merge.)

- [ ] **Step 3: Full final gates**

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo build --workspace
cargo test --workspace
```

Expected: all clean/green. Also run the repo prettier gate on changed non-Rust files (pinned binary, never npx):

```bash
C:/code/bloom/node_modules/.bin/prettier --check docs/superpowers/specs/2026-07-09-composed-sp2-package-server-design.md docs/superpowers/plans/2026-07-09-composed-sp2-package-server.md runtime/server/demo/composed.definition.json runtime/server/demo/composed.presentation.json
```

If prettier wants changes, run with `--write`, re-run `cargo test -p bloom-runtime-server --test composed` (the definition fixture feeds tests), and amend nothing — make a `style:` commit.

- [ ] **Step 4: Repo e2e rule**

The repo rule is `just e2e` before every PR. This branch is Rust-only (no studio frontend/backend/client change), so the Playwright suite cannot be affected; note this in the PR body instead of running the full browser suite. If the reviewer disagrees, run it against this worktree's offset ports (never :8000/:4200 — another session may hold them).

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin feat/composed-sp2
gh pr create --title "feat(runtime): composed@1 package build + server dispatch (SP2)" --body "$(cat <<'EOF'
Composed games SP2 per docs/superpowers/specs/2026-07-09-composed-sp2-package-server-design.md:

- bloom-simulator: build_composed_package + compose CLI (validated, dev-signed, uncurated SplitMix64 pool)
- bloom-runtime-server: LoadedGame dispatch (slots@1 | composed@1), /spin returns the lifecycle trace, /handshake carries the Game Definition, audit gains definition_hash (summary-only for composed)
- kernel: TriggerData re-export
- demo: composed proof game (base -> fs1 [retriggers] -> fs2) checked in as composed.pkg + end-to-end replay tests

slots@1 wire and audit output are byte-identical (existing tests unchanged).
Playwright e2e not run: Rust-only change, no studio/client surface touched.

Closes #169.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Execution notes

- Tasks 1–3 and 4–6 are two dependency chains; Task 4 depends on Task 1 (the `TriggerData` re-export), Task 6 depends on Tasks 3 and 5. Execute in numeric order — each task leaves the workspace compiling and green.
- Every task's Step "Gates" must actually be run; CI enforces fmt/clippy/build/test on the workspace (memory: a `cargo fmt --check` failure has bitten a merge before).

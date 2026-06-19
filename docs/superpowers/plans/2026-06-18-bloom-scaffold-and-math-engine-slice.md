# Bloom Scaffold & Math-Engine Determinism Slice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Bloom monorepo skeleton with its governance metadata, and prove the hardest contract in the system — deterministic, bit-reproducible seed expansion — with a minimal slot mechanic in the math engine.

**Architecture:** Three top-level domains (`studio/` build, `trusted/` certified core, `runtime/` run), each carrying an `AGENTS.md` that encodes its plane rules. A Rust Cargo workspace hosts the certified math engine (`trusted/math`), which expands a seed into a slot outcome using a small, fully-specified, integer-only PRNG (SplitMix64). The slice proves: same seed → same outcome, every time.

**Tech Stack:** Rust (edition 2021), Cargo workspace, `just` task runner. No external crate dependencies in `trusted/math` for this slice (SplitMix64 is hand-rolled so the kernel is fully specified and dependency-free).

**Scope note (deviation from spec §15):** This plan deliberately defers the Nx/TypeScript and uv/Python toolchain wiring to the `studio`/`client` sub-projects, where they are actually populated. Standing them up empty now would be busywork. This plan delivers the scaffold, the governance metadata, the Rust workspace, and the math-engine slice.

**Source spec:** `docs/superpowers/specs/2026-06-18-bloom-platform-architecture-design.md`

**Branch:** create `feat/math-engine-slice` off `main` before Task 1 (main is protected; land via PR).

## Global Constraints

- **Determinism is sacred** (spec §4, §9): in the math/outcome path use **integer-only** arithmetic — **no floats**, no clock/time, no I/O, no platform-dependent operations. The same `(model, seed)` MUST produce the same outcome on any machine, forever.
- **Dependency rule** (spec §3): nothing in `trusted/` may depend on `studio/`. The math engine depends on nothing in the repo.
- **Mechanics are append-only** (spec §7): a behavior change is a new mechanic *version*, never an edit to a shipped one.
- **Rust edition:** `2021`.
- **Commits:** Conventional Commits format (`type(scope): description`), per `AGENTS.md`.
- **No AI/automated free-editing inside `trusted/`** (spec §14) — this is certified-grade code.

---

### Task 1: Repo scaffold & governance metadata

Stands up the three-domain skeleton and writes the plane rules into per-domain `AGENTS.md`. No code yet; the reviewable deliverable is "the structure exists and the laws are written down."

**Files:**
- Create: `studio/AGENTS.md`
- Create: `trusted/AGENTS.md`
- Create: `runtime/AGENTS.md`
- Create: `.gitignore`
- Create: `justfile`
- Modify: `README.md` (replace the single-line stub)

**Interfaces:**
- Consumes: nothing.
- Produces: the directory structure and governance files that later tasks live inside.

- [ ] **Step 1: Create `studio/AGENTS.md`**

```markdown
# studio/ — the authoring plane

This is **where games are built**, and the **only** plane where AI lives.

- AI-driven, human-in-the-loop, fast-churning. **Not certified.**
- May depend on `trusted/`. **`trusted/` must never depend on `studio/`.**
- Languages here: React/TypeScript (`frontend/`), Python + FastAPI + Langchain
  (`backend/`, all AI orchestration), Rust (`simulator/`).
- Output: a signed **game package**, produced by the simulator and approved by a
  human at the sign-off gate before it can cross into `runtime/`.
```

- [ ] **Step 2: Create `trusted/AGENTS.md`**

```markdown
# trusted/ — the certified shared heart

Certified-grade code shared by **both** planes (the simulator and the server use
the math engine identically). Treat everything here as if a regulator will audit it.

- **Determinism is sacred.** Integer-only math in the outcome path: no floats, no
  clock/time, no I/O, no randomness source beyond an injected seed/index. Output
  MUST be bit-reproducible across platforms, forever.
- **Mechanics are append-only and immutable once shipped.** A behavior change is a
  NEW mechanic version, never an edit. Any change here is a re-certification event.
- **No AI / automated free-editing** of this code.
```

- [ ] **Step 3: Create `runtime/AGENTS.md`**

```markdown
# runtime/ — the authoritative plane

This is **where games run** for real-money play. **No AI, ever.**

- Authoritative source of truth; the client can never override the server.
- No nondeterminism beyond the certified index draw.
- The **audit log is append-only**; every round must stay bit-reproducible — record
  `(package id + version, seed drawn, math-engine version, bet, timestamp, outcome)`.
- This is the **operator-integration edge**. Bloom does NOT own wallet, accounts, or
  KYC/AML — those belong to the operator platform.
```

- [ ] **Step 4: Create `.gitignore`**

```gitignore
# Rust
/target
**/target

# Node / TypeScript (future)
node_modules
.nx/cache

# Python (future)
__pycache__/
.venv/
*.pyc
```

- [ ] **Step 5: Create `justfile`**

```just
# Cross-cutting commands. Only Rust is populated this round; TS/Python join later.
default:
    @just --list

build:
    cargo build --workspace

test:
    cargo test --workspace

fmt:
    cargo fmt --all

lint:
    cargo clippy --workspace --all-targets
```

- [ ] **Step 6: Replace `README.md`**

```markdown
# Bloom

An AI-driven, human-in-the-loop platform for designing and running real-money
generative-AI casino games.

- `studio/` — where you build games (authoring; AI lives here)
- `trusted/` — the certified shared heart (the math engine + the game-package format)
- `runtime/` — where games run (authoritative; no AI)

See `docs/superpowers/specs/2026-06-18-bloom-platform-architecture-design.md` for the
full architecture, and each domain's `AGENTS.md` for its rules.
```

- [ ] **Step 7: Verify structure**

Run: `ls studio/AGENTS.md trusted/AGENTS.md runtime/AGENTS.md .gitignore justfile README.md`
Expected: all six paths listed, no "No such file" errors.

- [ ] **Step 8: Commit**

```bash
git add studio/AGENTS.md trusted/AGENTS.md runtime/AGENTS.md .gitignore justfile README.md
git commit -m "chore: scaffold Bloom domains and governance metadata"
```

---

### Task 2: Rust workspace + math engine PRNG (SplitMix64)

Creates the Cargo workspace and the `bloom-math` crate, and implements the deterministic integer-only PRNG that all seed expansion is built on.

**Files:**
- Create: `Cargo.toml` (workspace root)
- Create: `trusted/math/Cargo.toml`
- Create: `trusted/math/src/lib.rs`
- Create: `trusted/math/src/rng.rs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `bloom_math::rng::SplitMix64` with `SplitMix64::new(seed: u64) -> SplitMix64`
    and `SplitMix64::next_u64(&mut self) -> u64`.

- [ ] **Step 1: Create the workspace root `Cargo.toml`**

```toml
[workspace]
resolver = "2"
members = ["trusted/math"]
```

- [ ] **Step 2: Create `trusted/math/Cargo.toml`**

```toml
[package]
name = "bloom-math"
version = "0.0.0"
edition = "2021"

[dependencies]
```

- [ ] **Step 3: Create `trusted/math/src/lib.rs` with the module declaration**

```rust
//! The Bloom math engine: deterministic, integer-only seed expansion.
//! See `trusted/AGENTS.md` — determinism here is sacred.

pub mod rng;
```

- [ ] **Step 4: Write the failing test for `SplitMix64`**

Create `trusted/math/src/rng.rs`:

```rust
//! SplitMix64 — a small, fully-specified, integer-only PRNG.
//! Deterministic and bit-reproducible across platforms (no floats, no
//! platform-dependent operations).

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_produces_same_sequence() {
        let mut a = SplitMix64::new(42);
        let mut b = SplitMix64::new(42);
        for _ in 0..1000 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
    }

    #[test]
    fn different_seeds_diverge() {
        let mut a = SplitMix64::new(1);
        let mut b = SplitMix64::new(2);
        assert_ne!(a.next_u64(), b.next_u64());
    }
}
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `cargo test -p bloom-math`
Expected: FAIL — compile error, `cannot find type SplitMix64 in this scope`.

- [ ] **Step 6: Implement `SplitMix64`**

Add to the top of `trusted/math/src/rng.rs` (above the `#[cfg(test)]` block):

```rust
pub struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    pub fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cargo test -p bloom-math`
Expected: PASS — `test result: ok. 2 passed`.

- [ ] **Step 8: Commit**

```bash
git add Cargo.toml trusted/math/Cargo.toml trusted/math/src/lib.rs trusted/math/src/rng.rs
git commit -m "feat(math): add deterministic SplitMix64 PRNG"
```

---

### Task 3: Slot mechanic — seed expansion

Implements mechanic #1 (slots): expand one seed into one visible row of symbols, one per reel. Probability is encoded by symbol multiplicity within each reel strip.

**Files:**
- Create: `trusted/math/src/mechanics/mod.rs`
- Create: `trusted/math/src/mechanics/slots.rs`
- Modify: `trusted/math/src/lib.rs` (add `pub mod mechanics;`)

**Interfaces:**
- Consumes: `bloom_math::rng::SplitMix64` (from Task 2).
- Produces:
  - `bloom_math::mechanics::slots::Symbol` = `u8`.
  - `bloom_math::mechanics::slots::SlotModel { pub reels: Vec<Vec<Symbol>> }`.
  - `bloom_math::mechanics::slots::expand(model: &SlotModel, seed: u64) -> Vec<Symbol>`.

- [ ] **Step 1: Add the `mechanics` module to `lib.rs`**

Modify `trusted/math/src/lib.rs` to read:

```rust
//! The Bloom math engine: deterministic, integer-only seed expansion.
//! See `trusted/AGENTS.md` — determinism here is sacred.

pub mod mechanics;
pub mod rng;
```

- [ ] **Step 2: Create the `mechanics` module file**

Create `trusted/math/src/mechanics/mod.rs`:

```rust
//! Game mechanics. Append-only: a new game family is a new module here, and a
//! behavior change to a shipped mechanic is a new version, never an edit.

pub mod slots;
```

- [ ] **Step 3: Write the failing test for `expand`**

Create `trusted/math/src/mechanics/slots.rs`:

```rust
//! Mechanic #1: slots. Expands one seed into one visible row of symbols.
//! Integer-only and deterministic — see `trusted/AGENTS.md`.

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_model() -> SlotModel {
        SlotModel {
            reels: vec![
                vec![0, 1, 2, 3, 4],
                vec![0, 1, 2, 3, 4],
                vec![0, 1, 2, 3, 4],
            ],
        }
    }

    #[test]
    fn produces_one_symbol_per_reel() {
        let model = sample_model();
        let row = expand(&model, 12345);
        assert_eq!(row.len(), 3);
    }

    #[test]
    fn every_symbol_comes_from_its_reel() {
        let model = sample_model();
        let row = expand(&model, 12345);
        for (i, sym) in row.iter().enumerate() {
            assert!(model.reels[i].contains(sym));
        }
    }
}
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cargo test -p bloom-math mechanics`
Expected: FAIL — compile error, `cannot find type SlotModel` / `cannot find function expand`.

- [ ] **Step 5: Implement the slot mechanic**

Add to the top of `trusted/math/src/mechanics/slots.rs` (above the `#[cfg(test)]` block):

```rust
use crate::rng::SplitMix64;

/// A symbol id. Its meaning (art, name, value) lives in the game package's
/// presentation manifest, never here.
pub type Symbol = u8;

/// The slot math model: one strip of symbols per reel. Outcome probability is
/// encoded by symbol multiplicity within each strip. Reels must be non-empty.
pub struct SlotModel {
    pub reels: Vec<Vec<Symbol>>,
}

/// Expand one seed into the visible row: one symbol per reel.
/// Deterministic — the same `(model, seed)` always yields the same row.
pub fn expand(model: &SlotModel, seed: u64) -> Vec<Symbol> {
    let mut rng = SplitMix64::new(seed);
    model
        .reels
        .iter()
        .map(|reel| {
            let stop = (rng.next_u64() % reel.len() as u64) as usize;
            reel[stop]
        })
        .collect()
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cargo test -p bloom-math mechanics`
Expected: PASS — `test result: ok. 2 passed`.

- [ ] **Step 7: Commit**

```bash
git add trusted/math/src/lib.rs trusted/math/src/mechanics/mod.rs trusted/math/src/mechanics/slots.rs
git commit -m "feat(math): add slot mechanic seed expansion"
```

---

### Task 4: Determinism / bit-reproducibility proof

The headline of the vertical slice (spec §15): prove that the same seed always yields the same outcome, repeatably. This is the contract the entire predetermined-seed-pool model rests on.

**Files:**
- Modify: `trusted/math/src/mechanics/slots.rs` (add to the existing `#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: `expand`, `SlotModel`, `Symbol` (from Task 3).
- Produces: no new public API — adds the determinism regression tests.

- [ ] **Step 1: Write the failing (then passing) determinism test**

In `trusted/math/src/mechanics/slots.rs`, inside the existing `mod tests` block, add:

```rust
    #[test]
    fn same_seed_same_row_repeatably() {
        let model = sample_model();
        let first = expand(&model, 999);
        for _ in 0..10_000 {
            assert_eq!(expand(&model, 999), first);
        }
    }

    #[test]
    fn distribution_reflects_multiplicity() {
        // A reel weighted 3:1 toward symbol 0 should land on 0 far more often.
        let model = SlotModel {
            reels: vec![vec![0, 0, 0, 1]],
        };
        let mut zeros = 0u32;
        for seed in 0..10_000u64 {
            if expand(&model, seed)[0] == 0 {
                zeros += 1;
            }
        }
        // Expected ~7500; assert a wide, deterministic-safe band.
        assert!(zeros > 6500 && zeros < 8500, "zeros = {}", zeros);
    }
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `cargo test -p bloom-math`
Expected: PASS — `test result: ok. 6 passed` (2 from rng, 2 from Task 3, 2 here).

- [ ] **Step 3: Run the full workspace check**

Run: `just test`
Expected: PASS — the whole workspace builds and all tests pass.

- [ ] **Step 4: Commit**

```bash
git add trusted/math/src/mechanics/slots.rs
git commit -m "test(math): prove deterministic seed expansion and multiplicity weighting"
```

---

## Self-Review

**1. Spec coverage (against §15 — this round's deliverable):**
- Repo scaffold → Task 1. ✓
- Per-domain `AGENTS.md` (the governance metadata) → Task 1, Steps 1–3. ✓
- Rust workspace → Task 2. ✓
- Math engine expands a trivial slot seed → Task 3. ✓
- Bit-reproducibility test passes → Task 4. ✓
- *Deferred (flagged in scope note):* Nx/TS and uv/Python wiring → their own sub-projects. Not a gap; an explicit deferral.

**2. Placeholder scan:** No "TBD"/"TODO"/"handle edge cases"; every code step shows complete code; every test step shows the assertions; every run step states expected output. The determinism guarantee is proven with value-independent assertions (no fabricated golden vectors). ✓

**3. Type consistency:** `SplitMix64::new`/`next_u64` (Task 2) are used unchanged in Task 3's `expand`. `SlotModel { reels: Vec<Vec<Symbol>> }`, `Symbol = u8`, and `expand(&SlotModel, u64) -> Vec<Symbol>` (Task 3) are used unchanged in Task 4. `sample_model()` defined in Task 3's test module is reused by Task 4's tests in the same module. ✓

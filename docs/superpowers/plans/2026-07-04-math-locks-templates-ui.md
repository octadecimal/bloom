# Math Consolidation SP2 — Locks + Templates UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Section-level locks `{reels, paytable, bonus}` that the GA genuinely cannot touch (genome omission in `bloom-tuner`), padlock toggles + an "Apply template…" picker in the Game Config pane, the one-line tune-route concurrency guard (issue #141), and (time-boxed) a product-shaped re-freeze of the high-vol-5x4 template (issue #142).

**Architecture:** Backend-out. Rust first: locks ride `tuner_config.json` into `TunerConfig`; a locked group's genes are simply **not encoded** (empty gene vector), `decode` copies that group verbatim from the seed model, and the existing mutate/crossover/repair loops no-op on empty groups — the search space genuinely shrinks with zero changes to the GA math. All-three-locked emits a new structured `{"type":"error"}` NDJSON frame. Python threads `doc.locks` (already stored since SP1) into `build_config` and parses the new frame. The frontend adds `locks` to the game-config wire/state, a padlock on the lockable tabs, and a confirm dialog over the SP1 `apply-template` endpoint (already lock-aware server-side).

**Tech Stack:** Rust (bloom-tuner, serde), Python (FastAPI, pydantic v2, pytest-asyncio, Motor), React + hookstate + Tailwind tokens + Radix Dialog + lucide-react, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-03-math-consolidation-design.md` (Sub-project 2 section). Issues: [#141](https://github.com/octadecimal/bloom/issues/141) in scope (Task 5), [#142](https://github.com/octadecimal/bloom/issues/142) in scope time-boxed (Task 9), #143 out of scope (runtime-server track).

## Global Constraints

- Semantic (Conventional Commits) format for every commit; imperative mood.
- TypeScript interfaces use the `I` prefix (`ISectionLocks`).
- No raw colors in `.ts/.tsx` — Tailwind token classes only (`design-language.guard.spec.ts` enforces).
- All existing REST routes, socket event names, and chat-agent tool names are **preserved** — this plan only adds fields/routes/params, never renames.
- Wire casing: `tuner_config.json` is snake_case; REST/socket docs are camelCase via pydantic `to_camel`. Lock keys are `reels` / `paytable` / `bonus` everywhere (the lock key `bonus` maps to model key `bonuses`; that mapping already lives in `app/math/templates.py:_LOCK_SECTIONS`).
- All-locked error copy, exact: `everything is locked — nothing to tune`.
- Rust gates (CI runs these): `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`.
- Frontend gates before every push (all four; vitest green alone proves nothing): `node_modules/.bin/prettier --check .` (pinned prettier — never bare `npx prettier` in a fresh worktree), `npx nx typecheck frontend`, `npx nx test frontend`, `npx nx build frontend`.
- Backend tests: from `studio/backend`, `uv run pytest` (unit; e2e-marked tests need `-m e2e` and the cargo toolchain — build the binary first with `cargo build --release -p bloom-tuner --bin tune_json`).
- **Worktree ports:** this worktree is `BLOOM_PORT_OFFSET=1` → backend `:8001`, frontend `:4201`. Never use `:8000/:4200` (another session may hold them). Export `BLOOM_PORT_OFFSET=1` in the shell before running Playwright, or `reuseExistingServer` silently attaches to the wrong stack.
- `just` recipes need `sh` — run them through Git Bash, not PowerShell.
- Worktree bootstrap (once, before Task 1): `npm install` at repo root, `uv sync` in `studio/backend`. `wt-new` does **not** copy `studio/backend/.env`; replay-mode e2e doesn't need it (no LLM calls in these specs).

## File Structure

| File                                                         | Change                                                                                                                                                                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `studio/tuner/src/config.rs`                                 | + `SectionLocks` struct; `TunerConfig.locks` field                                                                                                                                                                                         |
| `studio/tuner/src/genome.rs`                                 | + `encode_with_locks`; `decode` empty-group fallback; tests                                                                                                                                                                                |
| `studio/tuner/src/genetic.rs`                                | seed genome via `encode_with_locks`; lock tests                                                                                                                                                                                            |
| `studio/tuner/src/bin/tune_json.rs`                          | `LocksJson` parse (serde default); all-locked error frame; tests                                                                                                                                                                           |
| `studio/tuner/src/bin/tune.rs`                               | same `LocksJson` parse (dev CLI parity)                                                                                                                                                                                                    |
| `studio/backend/app/math/bounds.py`                          | `build_config(..., locks)` → `"locks"` key in config                                                                                                                                                                                       |
| `studio/backend/app/math/hub.py`                             | pass `doc.locks` to `build_config`; + `is_active()`                                                                                                                                                                                        |
| `studio/backend/app/math/runners/tune.py`                    | + `parse_tune_error_line`; `_drain_stdout` error branch                                                                                                                                                                                    |
| `studio/backend/app/math/rest.py`                            | `PutSlotModelBody.locks`; tune-route 409 guard (#141)                                                                                                                                                                                      |
| `studio/backend/tools/freeze_template.py`                    | optional lock args; used by Task 9                                                                                                                                                                                                         |
| `studio/backend/app/math/templates.py`                       | (Task 9 only) reshaped high-vol-5x4                                                                                                                                                                                                        |
| `studio/frontend/src/plugins/game-config/state.ts`           | + `ISectionLocks`, `defaultLocks()`, `locks` state                                                                                                                                                                                         |
| `studio/frontend/src/plugins/game-config/restClient.ts`      | `locks` on wire doc + patch; + `applyTemplate()`                                                                                                                                                                                           |
| `studio/frontend/src/plugins/game-config/actions.ts`         | hydrate/save locks; `toggleLock`; `applyTemplateToGame`                                                                                                                                                                                    |
| `studio/frontend/src/plugins/game-config/GameConfigPane.tsx` | padlock toggle + tab lock indicators + Apply template button                                                                                                                                                                               |
| `studio/frontend/src/plugins/game-config/TemplateDialog.tsx` | NEW — picker + confirm dialog                                                                                                                                                                                                              |
| `studio/frontend/e2e/game-config.spec.ts`                    | 2 new e2e tests                                                                                                                                                                                                                            |
| Tests                                                        | `studio/tuner/src/*` inline mods; `studio/backend/tests/test_tuner_bounds.py`, `test_tuner_runner_parse.py`, `test_tuner_tune_binary.py`, `test_math_hub.py`, `test_math_rest.py`; `game-config/actions.spec.ts`, `TemplateDialog.spec.ts` |

---

### Task 1: Rust — `SectionLocks` type + genome omission

**Files:**

- Modify: `studio/tuner/src/config.rs` (add struct + field)
- Modify: `studio/tuner/src/genome.rs` (encode_with_locks, decode fallback, tests)
- Modify (mechanical, compiler-driven): every `TunerConfig { … }` literal in the crate — `studio/tuner/src/genetic.rs` (test helper `cfg()` ~line 365), `studio/tuner/src/bin/tune_json.rs` (~line 216), `studio/tuner/src/bin/tune.rs`, plus any `TunerConfig` literals in `validate.rs`/other test mods (rustc will list them)

**Interfaces:**

- Consumes: existing `Genome { reel_counts: Vec<Vec<u32>>, payouts: Vec<u64>, bonuses: Vec<BonusGenes> }`, `encode(&SlotModel) -> Genome`, `decode(&Genome, &SlotModel) -> SlotModel` (`genome.rs`).
- Produces: `pub struct SectionLocks { pub reels: bool, pub paytable: bool, pub bonus: bool }` with `Default` + `pub fn all_locked(&self) -> bool` (config.rs); `pub locks: SectionLocks` on `TunerConfig`; `pub fn encode_with_locks(model: &SlotModel, locks: &SectionLocks) -> Genome` (genome.rs); `decode` treats an **empty gene group as locked** and copies that group verbatim from the template. Tasks 2–3 rely on these exact names.

- [ ] **Step 1: Write the failing genome tests**

Append inside `#[cfg(test)] mod tests` in `studio/tuner/src/genome.rs` (the existing `model()` and `bounds()` helpers are already in scope; add `SectionLocks` to the `use super::*`-visible imports via `use crate::config::SectionLocks;` at the top of the tests mod):

```rust
    #[test]
    fn encode_with_locks_omits_locked_groups() {
        let m = model();
        let l = SectionLocks { reels: true, paytable: false, bonus: true };
        let g = encode_with_locks(&m, &l);
        assert!(g.reel_counts.is_empty());
        assert_eq!(g.payouts, encode(&m).payouts); // unlocked group intact
        assert!(g.bonuses.is_empty());
    }

    #[test]
    fn decode_copies_locked_groups_verbatim_from_template() {
        // all three locked -> decode reproduces the seed model exactly,
        // byte-for-byte (reels keep their original order, not the round-robin
        // layout()).
        let m = model();
        let l = SectionLocks { reels: true, paytable: true, bonus: true };
        let d = decode(&encode_with_locks(&m, &l), &m);
        assert_eq!(d, m);
    }

    #[test]
    fn locked_group_survives_repair_of_the_rest() {
        // reels locked; corrupt + repair the remaining genes; reels untouched.
        let m = model();
        let l = SectionLocks { reels: true, ..Default::default() };
        let mut g = encode_with_locks(&m, &l);
        g.payouts[0] = u64::MAX;
        repair(&mut g, &m, &bounds());
        let d = decode(&g, &m);
        assert_eq!(d.reels, m.reels);
        assert!(d.paytable.entries[0].payout <= 100);
    }

    #[test]
    fn unlocked_encode_decode_behavior_is_unchanged() {
        // Default (no locks) must round-trip exactly as before.
        let m = model();
        let g = encode_with_locks(&m, &SectionLocks::default());
        assert_eq!(g, encode(&m));
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p bloom-tuner genome` (from repo root)
Expected: compile error — `SectionLocks` and `encode_with_locks` not found.

- [ ] **Step 3: Implement `SectionLocks` in config.rs**

Append to `studio/tuner/src/config.rs`:

```rust
/// Section-level automation locks. A locked group's genes are omitted from the
/// genome entirely (the search space genuinely shrinks); `decode` copies that
/// group verbatim from the seed model. Locks constrain automation, never humans.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SectionLocks {
    pub reels: bool,
    pub paytable: bool,
    pub bonus: bool,
}

impl SectionLocks {
    pub fn all_locked(&self) -> bool {
        self.reels && self.paytable && self.bonus
    }
}
```

Add the field to `TunerConfig` (after `weights`):

```rust
    pub weights: Weights,
    pub locks: SectionLocks,
}
```

- [ ] **Step 4: Implement genome omission in genome.rs**

Add below `encode` (import `SectionLocks`: change line 5 to `use crate::config::{GeneBounds, SectionLocks};`):

```rust
/// Encode only the unlocked gene groups. A locked group's genes are omitted
/// (empty vec): mutation/crossover/repair loops then skip the group naturally,
/// and `decode` copies it verbatim from the template.
pub fn encode_with_locks(model: &SlotModel, locks: &SectionLocks) -> Genome {
    let mut g = encode(model);
    if locks.reels {
        g.reel_counts.clear();
    }
    if locks.paytable {
        g.payouts.clear();
    }
    if locks.bonus {
        g.bonuses.clear();
    }
    g
}
```

Rewrite `decode` so each group falls back to a verbatim template copy when its gene group is empty (an empty group is either locked or genuinely absent from the template — in both cases the template copy is correct):

```rust
pub fn decode(genome: &Genome, template: &SlotModel) -> SlotModel {
    // An empty gene group means the group is locked (omitted from the genome)
    // or absent from the template: copy it verbatim from the template.
    let reels = if genome.reel_counts.is_empty() {
        template.reels.clone()
    } else {
        template
            .reels
            .iter()
            .zip(&genome.reel_counts)
            .map(|(reel, counts)| layout(&reel_symbols(reel), counts))
            .collect()
    };

    let entries = if genome.payouts.is_empty() {
        template.paytable.entries.clone()
    } else {
        template
            .paytable
            .entries
            .iter()
            .zip(&genome.payouts)
            .map(|(e, &payout)| PaytableEntry {
                symbol: e.symbol,
                count: e.count,
                payout,
            })
            .collect()
    };

    let bonuses = if genome.bonuses.is_empty() {
        template.bonuses.clone()
    } else {
        template
            .bonuses
            .iter()
            .zip(&genome.bonuses)
            .map(|(b, g)| match b {
                BonusFeature::FreeSpins { trigger, config } => BonusFeature::FreeSpins {
                    trigger: TriggerSpec {
                        symbol: trigger.symbol,
                        min_count: g.min_count,
                    },
                    config: FreeSpinsConfig {
                        spins_awarded: g.spins_awarded,
                        retrigger: config.retrigger,
                        multiplier: g.multiplier,
                        feature_reels: config.feature_reels.clone(),
                    },
                },
            })
            .collect()
    };

    SlotModel {
        symbols: template.symbols.clone(),
        reels,
        rows: template.rows,
        paylines: template.paylines.clone(),
        paytable: Paytable { entries },
        bonuses,
    }
}
```

- [ ] **Step 5: Fix every `TunerConfig` literal**

Run: `cargo build -p bloom-tuner --all-targets`
For every "missing field `locks`" error, add `locks: SectionLocks::default(),` to the struct literal (import `SectionLocks` where needed). Expected sites: `genetic.rs` test helper `cfg()`, `bin/tune_json.rs` `main`, `bin/tune.rs` `main`, plus any test-mod literals rustc reports (e.g. in `validate.rs`). In `bin/tune_json.rs` change the import line 7 to `use bloom_tuner::config::{GeneBounds, SectionLocks, TunerConfig, Weights};` (same pattern in `bin/tune.rs`).

- [ ] **Step 6: Run tests to verify pass**

Run: `cargo test -p bloom-tuner`
Expected: all pass, including the four new genome tests and every pre-existing test (behavior with default locks is unchanged).

- [ ] **Step 7: Commit**

```bash
git add studio/tuner/src
git commit -m "feat(tuner): SectionLocks + genome omission (locked groups not encoded)"
```

---

### Task 2: Rust — the GA honors locks

**Files:**

- Modify: `studio/tuner/src/genetic.rs` (one line in `tune_with_progress` + tests)

**Interfaces:**

- Consumes: `encode_with_locks(model, locks)` and the `decode` fallback from Task 1; `cfg.locks: SectionLocks`.
- Produces: `tune_with_progress`/`GeneticTuner::tune` respect `cfg.locks` — a locked section is byte-identical between the seed model and `TuneOutcome.model`. Determinism holds per `(master_seed, lock set)`. Task 3's binary and Task 4's Python tests rely on this.

- [ ] **Step 1: Write the failing tests**

Append inside `#[cfg(test)] mod tests` in `studio/tuner/src/genetic.rs` (helpers `toy(payout_sym2)`, `target_09()`, `cfg(master_seed)` already exist; add `use crate::config::SectionLocks;` to the tests-mod imports):

```rust
    fn cfg_locked(master_seed: u64, locks: SectionLocks) -> TunerConfig {
        TunerConfig { locks, ..cfg(master_seed) }
    }

    #[test]
    fn locked_reels_stay_byte_identical_across_a_full_tune() {
        // toy(1) is detuned (RTP ~0.5); payouts alone can reach 0.9 exactly
        // (sym2 pays 5 with the seed composition), so a reels-locked run must
        // still pass — with the reels untouched.
        let seed = toy(1);
        let c = cfg_locked(7, SectionLocks { reels: true, ..Default::default() });
        let out = GeneticTuner.tune(&seed, &target_09(), &c);
        assert_eq!(out.model.reels, seed.reels);
        assert!(matches!(out.verdict, Verdict::Pass), "verdict was {:?}", out.verdict);
    }

    #[test]
    fn locked_paytable_stays_byte_identical_across_a_full_tune() {
        let seed = toy(1);
        let c = cfg_locked(7, SectionLocks { paytable: true, ..Default::default() });
        let out = GeneticTuner.tune(&seed, &target_09(), &c);
        assert_eq!(out.model.paytable, seed.paytable);
    }

    #[test]
    fn locked_run_is_deterministic_per_lock_set() {
        let seed = toy(1);
        let locks = SectionLocks { reels: true, ..Default::default() };
        let a = GeneticTuner.tune(&seed, &target_09(), &cfg_locked(2026, locks.clone()));
        let b = GeneticTuner.tune(&seed, &target_09(), &cfg_locked(2026, locks));
        assert_eq!(a.model, b.model);
        assert_eq!(a.metrics.rtp, b.metrics.rtp);
        assert_eq!(a.trace.generations_run, b.trace.generations_run);
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p bloom-tuner genetic`
Expected: `locked_reels_stay_byte_identical_across_a_full_tune` and `locked_paytable_...` FAIL (the GA still mutates locked groups); the determinism test may pass by luck — the byte-identity tests are the RED signal.

- [ ] **Step 3: Implement**

In `studio/tuner/src/genetic.rs`, change the import (line 8) from
`use crate::genome::{decode, encode, repair, Genome};` to
`use crate::genome::{decode, encode_with_locks, repair, Genome};`
and the seed-genome line in `tune_with_progress` (line 126) from
`let base = encode(seed_model);` to:

```rust
    let base = encode_with_locks(seed_model, &cfg.locks);
```

That is the whole change: empty groups make the mutate loops (lines 41/52/57), crossover loops (86/91/96), and repair loops no-op for the locked sections, and Task 1's `decode` restores them from the template.

- [ ] **Step 4: Run tests to verify pass**

Run: `cargo test -p bloom-tuner`
Expected: all pass. Note `reproducible_same_seed_same_outcome` (unlocked) still passes — default locks reproduce today's exact RNG stream.

- [ ] **Step 5: Commit**

```bash
git add studio/tuner/src/genetic.rs
git commit -m "feat(tuner): GA seeds the genome through encode_with_locks"
```

---

### Task 3: Rust — locks on the `tune_json` wire + all-locked error frame

**Files:**

- Modify: `studio/tuner/src/bin/tune_json.rs` (LocksJson, error frame, main check, tests)
- Modify: `studio/tuner/src/bin/tune.rs` (same LocksJson parse, cfg mapping)

**Interfaces:**

- Consumes: `SectionLocks`/`all_locked()` (Task 1); `ConfigJson` (tune_json.rs:52), `emit()` (line 170).
- Produces: `tuner_config.json` optionally carries `"locks": {"reels": bool, "paytable": bool, "bonus": bool}` (absent → all unlocked, so every existing config file still parses); a new NDJSON frame `{"type": "error", "message": "..."}` emitted (exit 0) when all three sections are locked. Task 4's Python parser consumes this frame.

- [ ] **Step 1: Write the failing tests**

Append to the tests mod in `studio/tuner/src/bin/tune_json.rs`:

```rust
    const FULL_CONFIG: &str = r#"{
        "master_seed": 7, "population": 8, "max_generations": 4, "elitism": 1,
        "mutation_rate": 0.25, "crossover_rate": 0.9, "stagnation_window": 3,
        "search_candidate_count": 1000, "final_candidate_count": 1000,
        "bounds": {"payout_min": 0, "payout_max": 20, "spins_min": 1, "spins_max": 50,
                   "multiplier_min": 1, "multiplier_max": 10,
                   "min_count_min": 1, "min_count_max": 5},
        "weights": {"rtp": 1.0, "volatility": 1.0, "hit_rate": 1.0}"#;

    #[test]
    fn config_json_locks_default_to_unlocked() {
        let cj: ConfigJson = serde_json::from_str(&format!("{FULL_CONFIG}}}")).unwrap();
        assert!(!cj.locks.reels && !cj.locks.paytable && !cj.locks.bonus);
    }

    #[test]
    fn config_json_parses_locks() {
        let with_locks = format!(
            r#"{FULL_CONFIG}, "locks": {{"reels": true, "paytable": false, "bonus": true}}}}"#
        );
        let cj: ConfigJson = serde_json::from_str(&with_locks).unwrap();
        assert!(cj.locks.reels && !cj.locks.paytable && cj.locks.bonus);
    }

    #[test]
    fn error_line_shape() {
        let v: serde_json::Value =
            serde_json::from_str(&error_line("everything is locked — nothing to tune")).unwrap();
        assert_eq!(v["type"], "error");
        assert!(v["message"].as_str().unwrap().contains("locked"));
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p bloom-tuner --bin tune_json`
Expected: compile error — no field `locks` on `ConfigJson`, no `error_line`.

- [ ] **Step 3: Implement in tune_json.rs**

Add after `WeightsJson` (line 50):

```rust
#[derive(Deserialize, Default)]
struct LocksJson {
    #[serde(default)]
    reels: bool,
    #[serde(default)]
    paytable: bool,
    #[serde(default)]
    bonus: bool,
}
```

Add to `ConfigJson` (after `weights`):

```rust
    weights: WeightsJson,
    #[serde(default)]
    locks: LocksJson,
}
```

Add next to `progress_line`/`result_line`:

```rust
fn error_line(message: &str) -> String {
    json!({ "type": "error", "message": message }).to_string()
}
```

In `main`, replace the `locks: SectionLocks::default(),` placeholder (Task 1 Step 5) in the `TunerConfig` literal with:

```rust
        locks: SectionLocks {
            reels: cj.locks.reels,
            paytable: cj.locks.paytable,
            bonus: cj.locks.bonus,
        },
```

and insert the all-locked check between the `cfg` construction and the `validate` call:

```rust
    if cfg.locks.all_locked() {
        emit(error_line("everything is locked — nothing to tune"));
        return;
    }
```

Update the file's doc comment (lines 1–3) to mention the error frame: append `An all-locked config emits a {"type":"error"} frame and exits 0.`

- [ ] **Step 4: Mirror the parse in bin/tune.rs**

`studio/tuner/src/bin/tune.rs` duplicates the wire structs (its own `ConfigJson` at line 54). Add the same `LocksJson` struct, the same `#[serde(default)] locks: LocksJson` field, and map it into the `TunerConfig` literal exactly as in Step 3 (replacing that binary's Task 1 placeholder). No error frame — the file-out CLI just runs (an all-locked run returns the seed model, which is harmless for a dev tool).

- [ ] **Step 5: Run tests + repo Rust gates**

Run: `cargo test -p bloom-tuner && cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings`
Expected: all green. Fix any fmt/clippy findings now (CI hard-fails on both — this bit the sim-studio merge once already).

- [ ] **Step 6: Commit**

```bash
git add studio/tuner/src
git commit -m "feat(tuner): locks on the tune_json wire + all-locked error frame"
```

---

### Task 4: Python — thread `doc.locks` into the tuner config + parse the error frame

**Files:**

- Modify: `studio/backend/app/math/bounds.py` (build_config signature)
- Modify: `studio/backend/app/math/hub.py:124` (pass doc.locks)
- Modify: `studio/backend/app/math/runners/tune.py` (parse_tune_error_line + drain branch)
- Test: `studio/backend/tests/test_tuner_bounds.py`, `tests/test_math_hub.py`, `tests/test_tuner_runner_parse.py`, `tests/test_tuner_tune_binary.py`

**Interfaces:**

- Consumes: `SectionLocks` (`app/math/models.py:174`, pydantic, defaults all-False); `SlotModelDoc.locks`; the Task 3 wire (`"locks"` key, `{"type":"error","message":…}` frame).
- Produces: `build_config(params: TuningParams, bounds: dict, locks: SectionLocks | None = None) -> dict` — emits a `"locks"` key always (all-False when None, so `tools/freeze_template.py` and old call sites stay valid); `parse_tune_error_line(obj: dict, *, ran_at: str) -> TuneResult` in `runners/tune.py`. An all-locked tune surfaces exactly like any tune error today: `TuneResult(status="error", failure=…)` → `save_tune_result` → socket `tuning_failed {gameId, doc}` — **no new event names**.

- [ ] **Step 1: Write the failing tests**

In `studio/backend/tests/test_tuner_bounds.py`, extend the key-set assertion in `test_build_config_emits_snake_case_rust_contract` (line 34) to include `"locks"`, and append:

```python
def test_build_config_carries_locks():
    from app.math.models import SectionLocks
    cfg = build_config(default_tuning_params(), derive_bounds({}),
                       SectionLocks(paytable=True))
    assert cfg["locks"] == {"reels": False, "paytable": True, "bonus": False}


def test_build_config_defaults_locks_unlocked():
    cfg = build_config(default_tuning_params(), derive_bounds({}))
    assert cfg["locks"] == {"reels": False, "paytable": False, "bonus": False}
```

In `studio/backend/tests/test_math_hub.py`, append (fixtures `FakeSio`, `FakeGdd`, `_pass_tune_result`, `_pass_curation_result` already exist in the file):

```python
class _ConfigCapturingTunerRunner:
    def __init__(self, result):
        self._result = result
        self.config: dict | None = None

    async def run(self, seed_model, target, config, on_progress):
        self.config = config
        return self._result


@pytest.mark.asyncio
async def test_request_tune_passes_doc_locks_into_tuner_config(mongo_db):
    from app.math.models import SectionLocks
    store = MathStore(mongo_db)
    await store.put("g1", model={"bonuses": []}, locks=SectionLocks(reels=True))
    run_store = MathRunStore(mongo_db)
    runner = _ConfigCapturingTunerRunner(_pass_tune_result())
    sio = FakeSio()
    hub = MathHub(sio, store, run_store,
                  FakeCurationRunner(progress=[], result=_pass_curation_result()),
                  runner, FakeGdd({"rtp": 0.9, "volatility": "low"}))

    await hub.request_tune("g1")

    assert runner.config is not None
    assert runner.config["locks"] == {"reels": True, "paytable": False, "bonus": False}
```

In `studio/backend/tests/test_tuner_runner_parse.py`, append:

```python
def test_parse_tune_error_line_maps_message_to_failure():
    from app.math.runners.tune import parse_tune_error_line
    res = parse_tune_error_line(
        {"type": "error", "message": "everything is locked — nothing to tune"},
        ran_at="t")
    assert res.status == "error"
    assert res.verdict is None
    assert res.tuned_model is None
    assert "locked" in res.failure
    assert res.ran_at == "t"
```

In `studio/backend/tests/test_tuner_tune_binary.py`, append (module constants `DETUNED`, `TARGET_09`, `_fast_params` already exist):

```python
@pytest.mark.e2e
@pytest.mark.asyncio
async def test_all_locked_returns_structured_error():
    from app.math.models import SectionLocks
    config = build_config(_fast_params(), derive_bounds(DETUNED),
                          SectionLocks(reels=True, paytable=True, bonus=True))
    runner = SubprocessTunerRunner(get_settings())
    res = await runner.run(DETUNED, TARGET_09, config, on_progress=lambda p: None)
    assert res.status == "error"
    assert "locked" in (res.failure or "")
```

- [ ] **Step 2: Run to verify failure**

Run (from `studio/backend`): `uv run pytest tests/test_tuner_bounds.py tests/test_math_hub.py tests/test_tuner_runner_parse.py -x`
Expected: FAIL — `build_config` takes 2 args / no `"locks"` key; `parse_tune_error_line` import error.

- [ ] **Step 3: Implement**

`studio/backend/app/math/bounds.py` — change the import and `build_config`:

```python
from app.math.models import SectionLocks, TuningParams
```

```python
def build_config(params: TuningParams, bounds: dict,
                 locks: SectionLocks | None = None) -> dict:
    lk = locks or SectionLocks()
    return {
        "master_seed": params.master_seed,
        "population": params.population,
        "max_generations": params.max_generations,
        "elitism": params.elitism,
        "mutation_rate": params.mutation_rate,
        "crossover_rate": params.crossover_rate,
        "stagnation_window": params.stagnation_window,
        "search_candidate_count": params.search_candidate_count,
        "final_candidate_count": params.final_candidate_count,
        "bounds": dict(bounds),
        "weights": {
            "rtp": params.weights.rtp,
            "volatility": params.weights.volatility,
            "hit_rate": params.weights.hit_rate,
        },
        "locks": {"reels": lk.reels, "paytable": lk.paytable, "bonus": lk.bonus},
    }
```

`studio/backend/app/math/hub.py:124` — change to:

```python
        config = build_config(doc.tuner_params, derive_bounds(model), doc.locks)
```

`studio/backend/app/math/runners/tune.py` — add below `parse_tune_result_line` (line 103):

```python
def parse_tune_error_line(obj: dict, *, ran_at: str) -> TuneResult:
    """A structured {"type":"error"} frame from the binary (e.g. all sections
    locked) — same shape the runner synthesizes for crashes/watchdog kills."""
    return TuneResult(status="error", verdict=None, tuned_model=None, metrics=None,
                      missed=[], trace=[],
                      failure=obj.get("message") or "tuner error", ran_at=ran_at)
```

and in `_drain_stdout` (after the `elif obj.get("type") == "result":` branch, line 174–175):

```python
                    elif obj.get("type") == "error":
                        result = parse_tune_error_line(obj, ran_at=ran_at)
```

- [ ] **Step 4: Run unit tests to verify pass**

Run (from `studio/backend`): `uv run pytest`
Expected: PASS (the full unit suite — `test_math_generate.py`/`test_tuner_runner.py` exercise the changed call paths).

- [ ] **Step 5: Run the binary e2e tests**

Run: `cargo build --release -p bloom-tuner --bin tune_json` (repo root), then from `studio/backend`: `uv run pytest tests/test_tuner_tune_binary.py tests/test_math_templates_binary.py -m e2e`
Expected: PASS, including `test_all_locked_returns_structured_error` (proves the Rust frame and the Python parse agree end-to-end) and the template targets (proves default-locks configs didn't perturb determinism).

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/math studio/backend/tests
git commit -m "feat(math): thread section locks into the tuner config; parse error frames"
```

---

### Task 5: Python — PUT accepts `locks` + tune-route 409 guard (issue #141)

**Files:**

- Modify: `studio/backend/app/math/rest.py` (PutSlotModelBody, put_slot_model, tune_tuner)
- Modify: `studio/backend/app/math/hub.py` (is_active)
- Test: `studio/backend/tests/test_math_rest.py`

**Interfaces:**

- Consumes: `MathStore.put(game_id, *, …, locks: SectionLocks | None = None, source=…)` (already exists, already triggers the `slot_model_changed` broadcast on locks writes — `store.py:102-110`); `MathHub._active` (hub.py:44).
- Produces: `PUT /games/{id}/slot-model` accepts `"locks": {reels, paytable, bonus}`; `MathHub.is_active(game_id) -> bool`; `POST /games/{id}/tuner/tune` returns 409 with detail `a math run is already in progress for this game` while a generate pipeline holds the reservation. Task 6's frontend save path relies on the PUT field.

- [ ] **Step 1: Write the failing tests**

Append to `studio/backend/tests/test_math_rest.py` (helpers `_req`, `_generate_hub`, `_GatedTunerRunner`, `_pass_tune_result`, `SectionLocks` import already in the file):

```python
@pytest.mark.asyncio
async def test_put_slot_model_persists_locks_and_broadcasts(mongo_db):
    events: list[str] = []

    async def on_change(doc, source):
        events.append(source)

    store = MathStore(mongo_db, on_change=on_change)
    await store.put("g1", model={"reels": [[0]]})
    events.clear()
    req = _req(math_store=store)

    body = rest.PutSlotModelBody(locks=SectionLocks(paytable=True), source="editor")
    out = await rest.put_slot_model("g1", body, req)

    assert out["locks"] == {"reels": False, "paytable": True, "bonus": False}
    assert events == ["editor"]  # a locks write broadcasts slot_model_changed
    saved = await store.get("g1")
    assert saved.locks.paytable is True


@pytest.mark.asyncio
async def test_put_slot_model_without_locks_leaves_them_untouched(mongo_db):
    store = MathStore(mongo_db)
    await store.put("g1", model={"reels": [[0]]}, locks=SectionLocks(reels=True))
    req = _req(math_store=store)

    out = await rest.put_slot_model("g1", rest.PutSlotModelBody(model={"reels": [[1]]}), req)

    assert out["locks"] == {"reels": True, "paytable": False, "bonus": False}


@pytest.mark.asyncio
async def test_tune_route_returns_409_while_generate_active(mongo_db):
    gated = _GatedTunerRunner(_pass_tune_result())
    hub = _generate_hub(mongo_db, tuner_runner=gated)
    req = _req(math_hub=hub)

    resp = await rest.generate_math("g1", req)
    assert resp.status_code == 202
    await asyncio.sleep(0)  # let the pipeline reserve + park on the gate

    with pytest.raises(HTTPException) as exc_info:
        await rest.tune_tuner("g1", req)
    assert exc_info.value.status_code == 409

    gated.gate.set()


@pytest.mark.asyncio
async def test_tune_route_returns_202_when_idle(mongo_db):
    hub = _generate_hub(
        mongo_db, tuner_runner=FakeTunerRunner(progress=[], result=_pass_tune_result()))
    resp = await rest.tune_tuner("g1", _req(math_hub=hub))
    assert resp.status_code == 202
    await asyncio.sleep(0)  # let the fired task start
```

- [ ] **Step 2: Run to verify failure**

Run (from `studio/backend`): `uv run pytest tests/test_math_rest.py -x -k "locks or tune_route"`
Expected: FAIL — `PutSlotModelBody` has no field `locks`; tune route returns 202 instead of raising.

- [ ] **Step 3: Implement**

`studio/backend/app/math/rest.py` — import `SectionLocks` (extend the line-8 import), add to `PutSlotModelBody`:

```python
class PutSlotModelBody(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    model: dict | None = None
    params: CurationParams | None = None
    presentation: dict | None = None
    locks: SectionLocks | None = None
    source: str = "api"
```

pass it through in `put_slot_model`:

```python
    doc = await request.app.state.math_store.put(
        game_id, model=body.model, params=body.params,
        presentation=body.presentation, locks=body.locks, source=body.source)
```

and guard the tune route (issue #141 — one line; the route itself dies with the panes in sub-project 3, and this deliberately does not reserve, so a generate starting mid-pane-tune is still possible — same as today):

```python
@router.post("/games/{game_id}/tuner/tune", status_code=202)
async def tune_tuner(game_id: str, request: Request) -> Response:
    if request.app.state.math_hub.is_active(game_id):
        raise HTTPException(status_code=409,
                            detail="a math run is already in progress for this game")
    asyncio.create_task(request.app.state.math_hub.request_tune(game_id))
    return Response(status_code=202)
```

`studio/backend/app/math/hub.py` — add next to `_reserve` (line 181):

```python
    def is_active(self, game_id: str) -> bool:
        """A generate pipeline currently holds this game's reservation."""
        return game_id in self._active
```

- [ ] **Step 4: Run tests to verify pass**

Run (from `studio/backend`): `uv run pytest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/math studio/backend/tests
git commit -m "feat(math): PUT slot-model accepts locks; guard pane tune vs generate (#141)"
```

---

### Task 6: Frontend — locks state + padlock UI

**Files:**

- Modify: `studio/frontend/src/plugins/game-config/state.ts`
- Modify: `studio/frontend/src/plugins/game-config/restClient.ts`
- Modify: `studio/frontend/src/plugins/game-config/actions.ts`
- Modify: `studio/frontend/src/plugins/game-config/GameConfigPane.tsx`
- Test: `studio/frontend/src/plugins/game-config/actions.spec.ts`

**Interfaces:**

- Consumes: the Task 5 PUT contract (`locks` in body, camelCase wire `locks: {reels, paytable, bonus}` on GET/PUT responses — `sim_wire` already emits it); existing `scheduleSave`/`flushPendingSave` debounce (600 ms) and watermark reconcile in `actions.ts`.
- Produces: `interface ISectionLocks { reels: boolean; paytable: boolean; bonus: boolean }` + `defaultLocks()` in **state.ts** (state.ts so the `vi.mock('./restClient')` in specs never has to fake it); `toggleLock(section: keyof ISectionLocks)` action; testids `gc-lock-{reels|paytable|bonus}` (toggle, right end of the tab bar, shown for the active lockable tab) and `gc-tab-lock-{reels|paytable|bonus}` (indicator icon on a locked tab). Task 7's dialog reads `s.locks`; Task 8's e2e drives these testids.

- [ ] **Step 1: Write the failing vitest cases**

In `studio/frontend/src/plugins/game-config/actions.spec.ts`: extend the `doc()` helper (line 37) with an optional locks param —

```ts
function doc(model: unknown, updatedAt: string, presentation: unknown = { symbols: {} }, locks?: unknown) {
  return { id: 'd1', gameId: 'g1', model, presentation, updatedAt, ...(locks ? { locks } : {}) };
}
```

add `toggleLock` to the `./actions` import list, and append:

```ts
it('openGameConfig hydrates locks, defaulting to all-unlocked when absent', async () => {
  await open(); // doc without locks
  expect(gameConfigSlice().locks.get({ noproxy: true })).toEqual({ reels: false, paytable: false, bonus: false });
  getSlotModel.mockResolvedValue(doc(MODEL, 't2', { symbols: {} }, { reels: true, paytable: false, bonus: false }));
  await openGameConfig('g1');
  expect(gameConfigSlice().locks.reels.get()).toBe(true);
});

it('toggleLock flips the lock and debounce-PUTs locks only', async () => {
  await open();
  putSlotModel.mockResolvedValue(doc(MODEL, 't2', { symbols: {} }, { reels: false, paytable: true, bonus: false }));
  toggleLock('paytable');
  expect(gameConfigSlice().locks.paytable.get()).toBe(true);
  expect(gameConfigSlice().sync.get()).toBe('saving');
  await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 10);
  expect(putSlotModel).toHaveBeenCalledTimes(1);
  const [, patch] = putSlotModel.mock.calls[0];
  expect(patch.locks).toEqual({ reels: false, paytable: true, bonus: false });
  expect(patch.model).toBeUndefined();
  expect(patch.source).toBe('editor');
  expect(gameConfigSlice().sync.get()).toBe('saved');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx nx test frontend -- src/plugins/game-config/actions.spec.ts`
Expected: FAIL — `toggleLock` is not exported; `s.locks` does not exist.

- [ ] **Step 3: Implement state + wire types**

`state.ts` — add above `IGameConfigState`:

```ts
export interface ISectionLocks {
  reels: boolean;
  paytable: boolean;
  bonus: boolean;
}

export function defaultLocks(): ISectionLocks {
  return { reels: false, paytable: false, bonus: false };
}
```

add `locks: ISectionLocks;` to `IGameConfigState` (after `presentation`) and `locks: defaultLocks(),` to `makeInitialState()`.

`restClient.ts` — import the type and extend the wire shapes:

```ts
import type { ISectionLocks } from './state';

export interface ISlotModelWireDoc {
  id: string;
  gameId: string;
  model: unknown;
  presentation?: unknown; // absent until the backend task lands; normalized on hydrate
  locks?: ISectionLocks;
  updatedAt: string;
}

export interface IPutSlotModelPatch {
  model?: ISlotModel;
  presentation?: IPresentation;
  locks?: ISectionLocks;
  source: string;
}
```

and change `putSlotModel`'s `patch` parameter type to `IPutSlotModelPatch`.

- [ ] **Step 4: Implement actions**

`actions.ts` changes:

1. Import: add `defaultLocks, type ISectionLocks` to the `./state` import; use `IPutSlotModelPatch` from `./restClient`.
2. `dirty` (line 12): `let dirty = { model: false, presentation: false, locks: false };` — same shape in `closeGameConfig` (line 50) and `flushPendingSave` reset (line 80).
3. `hydrateDoc` — after the presentation line: `s.locks.set({ ...defaultLocks(), ...(doc.locks ?? {}) });`
4. `closeGameConfig` — after `s.presentation.set(...)`: `s.locks.set(defaultLocks());`
5. `scheduleSave` kind: `'model' | 'presentation' | 'locks'`.
6. `flushPendingSave` — guard becomes `if (!gameId || (!dirty.model && !dirty.presentation && !dirty.locks)) return;`, patch is typed `IPutSlotModelPatch`, and after the presentation line add: `if (dirty.locks) patch.locks = s.locks.get({ noproxy: true }) as ISectionLocks;`
7. New action:

```ts
export function toggleLock(section: keyof ISectionLocks): void {
  const s = gameConfigSlice();
  s.locks[section].set(!s.locks[section].get());
  scheduleSave('locks');
}
```

- [ ] **Step 5: Run vitest to verify pass**

Run: `npx nx test frontend -- src/plugins/game-config/actions.spec.ts`
Expected: PASS (all pre-existing cases too — `handleModelChanged` and the save path are unchanged for model/presentation).

- [ ] **Step 6: Implement the pane UI**

`GameConfigPane.tsx`:

```tsx
import { Lock, LockOpen } from 'lucide-react';
import { toggleLock } from './actions';
import { gameConfigHooks, type ISectionLocks } from './state';
```

Above the component:

```tsx
const LOCKABLE: Partial<Record<GcTab, keyof ISectionLocks>> = {
  reels: 'reels',
  paytable: 'paytable',
  bonus: 'bonus',
};
```

In the component body (after `const activeTab = ...`): `const locks = s.locks.get({ noproxy: true }) as ISectionLocks;`

In the tab `map` callback, add before the `return`: `const lockKey = LOCKABLE[t.key];` and inside the button, after the issues dot:

```tsx
{
  lockKey && locks[lockKey] && <Lock data-testid={`gc-tab-lock-${t.key}`} className="h-3 w-3 text-text-3" />;
}
```

After the `{TABS.map(...)}` block, still inside the tab-bar `div` (it is `flex items-center`), add the toggle for the active lockable section:

```tsx
{
  (() => {
    const lockKey = LOCKABLE[activeTab];
    if (!lockKey) return null;
    const locked = locks[lockKey];
    return (
      <button
        data-testid={`gc-lock-${lockKey}`}
        title={
          locked
            ? 'Locked against automation (GA, templates) — still editable by hand. Click to unlock.'
            : 'Lock this section against automation (GA, templates). Humans can always edit.'
        }
        onClick={() => toggleLock(lockKey)}
        className={`ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs ${locked ? 'text-warning' : 'text-text-2'} hover:bg-raised hover:text-text-1`}
      >
        {locked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
        {locked ? 'Locked' : 'Lock'}
      </button>
    );
  })();
}
```

- [ ] **Step 7: Run all four frontend gates**

Run: `node_modules/.bin/prettier --check .` (fix with `--write` if needed), `npx nx typecheck frontend`, `npx nx test frontend`, `npx nx build frontend`
Expected: all green (the design-language guard test stays green — only token classes above).

- [ ] **Step 8: Commit**

```bash
git add studio/frontend/src/plugins/game-config
git commit -m "feat(game-config): padlock toggles bound to section locks"
```

---

### Task 7: Frontend — "Apply template…" picker + confirm dialog

**Files:**

- Create: `studio/frontend/src/plugins/game-config/TemplateDialog.tsx`
- Create: `studio/frontend/src/plugins/game-config/TemplateDialog.spec.ts`
- Modify: `studio/frontend/src/plugins/game-config/restClient.ts` (+applyTemplate)
- Modify: `studio/frontend/src/plugins/game-config/actions.ts` (+applyTemplateToGame)
- Modify: `studio/frontend/src/plugins/game-config/GameConfigPane.tsx` (button + dialog mount)
- Test: `studio/frontend/src/plugins/game-config/actions.spec.ts`

**Interfaces:**

- Consumes: SP1 backend `POST /games/{id}/slot-model/apply-template {name}` (404 on unknown name; merges template over unlocked sections, keeps locked; broadcasts `slot_model_changed` with `source: "template"`; returns the merged `sim_wire` doc); `hydrateDoc` + watermark echo-suppression (`actions.ts:129` — hydrating the POST response advances the watermark, so the `source:"template"` socket echo is swallowed and the initiating pane shows no "updated externally" flash); `Dialog`/`Button` primitives (`components/ui/dialog.tsx`, `components/ui/button.tsx` — copy the `SaveLayoutDialog.tsx` shape).
- Produces: `applyTemplate(gameId, name): Promise<ISlotModelWireDoc>` (restClient); `applyTemplateToGame(name): Promise<void>` (actions); `templateSummary(locks): { overwritten: string[]; kept: string[] }` + `<TemplateDialog open onOpenChange locks>` with testids `gc-apply-template` (opener button), `gc-template-select`, `gc-template-summary`, `gc-template-protected`, `gc-template-confirm`, `gc-template-cancel`. Task 8's e2e drives these.

- [ ] **Step 1: Write the failing tests**

`studio/frontend/src/plugins/game-config/TemplateDialog.spec.ts` (pure-function test — no rendering needed):

```ts
import { describe, it, expect } from 'vitest';
import { templateSummary, TEMPLATE_OPTIONS } from './TemplateDialog';

describe('templateSummary', () => {
  it('everything unlocked: all five sections overwritten, none kept', () => {
    const s = templateSummary({ reels: false, paytable: false, bonus: false });
    expect(s.overwritten).toEqual(['symbols', 'paylines', 'reels', 'paytable', 'bonus']);
    expect(s.kept).toEqual([]);
  });

  it('locked sections move to kept; symbols/paylines are never protectable', () => {
    const s = templateSummary({ reels: true, paytable: true, bonus: false });
    expect(s.overwritten).toEqual(['symbols', 'paylines', 'bonus']);
    expect(s.kept).toEqual(['reels', 'paytable']);
  });

  it('offers exactly the three shipped templates', () => {
    expect(TEMPLATE_OPTIONS.map((t) => t.name)).toEqual(['classic-3x3', 'video-5x3', 'high-vol-5x4']);
  });
});
```

In `actions.spec.ts`: add `applyTemplate` to the restClient mock factory —

```ts
const applyTemplate = vi.fn();
vi.mock('./restClient', () => ({
  putSlotModel: (...a: unknown[]) => putSlotModel(...a),
  getSlotModel: (...a: unknown[]) => getSlotModel(...a),
  applyTemplate: (...a: unknown[]) => applyTemplate(...a),
}));
```

add `applyTemplate.mockReset();` to `beforeEach`, `applyTemplateToGame` to the `./actions` import, and append:

```ts
it('applyTemplateToGame hydrates the returned doc and swallows the template socket echo', async () => {
  await open();
  const merged = { ...MODEL, rows: 5 };
  applyTemplate.mockResolvedValue(doc(merged, 't3', { symbols: {} }, { reels: false, paytable: true, bonus: false }));
  await applyTemplateToGame('video-5x3');
  expect(applyTemplate).toHaveBeenCalledWith('g1', 'video-5x3');
  const s = gameConfigSlice();
  expect(s.model.rows.get()).toBe(5);
  expect(s.watermark.get()).toBe('t3');
  expect(s.sync.get()).toBe('saved');
  // the slot_model_changed echo (source "template", same updatedAt) must not re-hydrate
  handleModelChanged({ gameId: 'g1', updatedAt: 't3', source: 'template' });
  expect(getSlotModel).toHaveBeenCalledTimes(1); // only the open() call
  expect(s.sync.get()).toBe('saved');
});

it('a failed applyTemplateToGame sets sync=error', async () => {
  await open();
  applyTemplate.mockRejectedValue(new Error('boom'));
  await applyTemplateToGame('classic-3x3');
  expect(gameConfigSlice().sync.get()).toBe('error');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx nx test frontend -- src/plugins/game-config`
Expected: FAIL — `./TemplateDialog` module not found; `applyTemplateToGame` not exported.

- [ ] **Step 3: Implement restClient + action**

`restClient.ts` — append:

```ts
export async function applyTemplate(gameId: string, name: string): Promise<ISlotModelWireDoc> {
  return okJson<ISlotModelWireDoc>(
    await fetch(`${BACKEND_URL}/games/${gameId}/slot-model/apply-template`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  );
}
```

`actions.ts` — add `applyTemplate` to the restClient import and append:

```ts
/** Apply-template confirm. Hydrating the POST response advances the watermark,
 * so the source:"template" socket echo is swallowed (no external flash here). */
export async function applyTemplateToGame(name: string): Promise<void> {
  const s = gameConfigSlice();
  const gameId = s.activeGameId.get();
  if (!gameId) return;
  try {
    hydrateDoc(await applyTemplate(gameId, name));
    s.sync.set('saved');
  } catch {
    s.sync.set('error');
  }
}
```

- [ ] **Step 4: Implement the dialog**

`studio/frontend/src/plugins/game-config/TemplateDialog.tsx`:

```tsx
import { useState } from 'react';
import { Dialog, DialogContent } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import type { ISectionLocks } from './state';
import { applyTemplateToGame } from './actions';

// ponytail: static mirror of GET /slot-model/templates — the set is 3 frozen
// templates; fetch the list only if templates ever become dynamic.
export const TEMPLATE_OPTIONS = [
  { name: 'classic-3x3', label: 'Classic 3×3' },
  { name: 'video-5x3', label: 'Video 5×3' },
  { name: 'high-vol-5x4', label: 'High Volatility 5×4' },
] as const;

const LOCKABLE = ['reels', 'paytable', 'bonus'] as const;

/** Which sections the template will overwrite vs keep, given current locks.
 * Symbols and paylines are never lockable (the GA cannot touch them). */
export function templateSummary(locks: ISectionLocks): { overwritten: string[]; kept: string[] } {
  const kept = LOCKABLE.filter((k) => locks[k]) as string[];
  const overwritten = ['symbols', 'paylines', ...LOCKABLE.filter((k) => !locks[k])];
  return { overwritten, kept };
}

export interface ITemplateDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  locks: ISectionLocks;
}

export function TemplateDialog({ open, onOpenChange, locks }: ITemplateDialogProps) {
  const [name, setName] = useState<string>('video-5x3');
  const { overwritten, kept } = templateSummary(locks);

  const confirm = async () => {
    await applyTemplateToGame(name);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Apply template</h2>
        <select
          data-testid="gc-template-select"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-7 rounded border border-border bg-canvas px-1 text-xs text-text-1"
        >
          {TEMPLATE_OPTIONS.map((t) => (
            <option key={t.name} value={t.name}>
              {t.label}
            </option>
          ))}
        </select>
        <div data-testid="gc-template-summary" className="text-xs text-text-2">
          <div>Overwrites: {overwritten.join(', ')}.</div>
          {kept.length > 0 && (
            <div data-testid="gc-template-protected" className="text-warning">
              Lock-protected (kept): {kept.join(', ')}.
            </div>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button data-testid="gc-template-cancel" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button data-testid="gc-template-confirm" onClick={() => void confirm()}>
            Apply
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 5: Mount in the pane**

`GameConfigPane.tsx` — add imports:

```tsx
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { TemplateDialog } from './TemplateDialog';
```

in the component body add `const [templateOpen, setTemplateOpen] = useState(false);`, and in the stats row change the right-hand span to lead with the opener:

```tsx
        <span className="ml-auto inline-flex items-center gap-2">
          <Button data-testid="gc-apply-template" variant="outline" size="sm" onClick={() => setTemplateOpen(true)}>
            Apply template…
          </Button>
          {issues.length > 0 && (
```

and mount the dialog just before the closing root `</div>`:

```tsx
<TemplateDialog open={templateOpen} onOpenChange={setTemplateOpen} locks={locks} />
```

- [ ] **Step 6: Run all four frontend gates**

Run: `node_modules/.bin/prettier --check .`, `npx nx typecheck frontend`, `npx nx test frontend`, `npx nx build frontend`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add studio/frontend/src/plugins/game-config
git commit -m "feat(game-config): apply-template picker with lock-aware confirm dialog"
```

---

### Task 8: E2e — padlock persistence + apply-template respects locks + full suite

**Files:**

- Modify: `studio/frontend/e2e/game-config.spec.ts` (2 new tests)

**Interfaces:**

- Consumes: everything above; spec helpers `setupGame`, `openGameConfig`, `getModelDoc`, `MODEL`, `BACKEND` already in the file. video-5x3 template = 5 reels × 3 rows.

- [ ] **Step 1: Write the two tests**

Append to `studio/frontend/e2e/game-config.spec.ts`:

```ts
test('padlock toggle persists via PUT and survives a reload', async ({ page, request }) => {
  const roomName = `gc ${Date.now()}`;
  const gameId = await setupGame(page, request, 'ivy', roomName);
  await openGameConfig(page);
  await page.getByTestId('gc-tab-paytable').click();
  await page.getByTestId('gc-lock-paytable').click();
  await expect(page.getByTestId('gc-sync-pill')).toContainText('saved', { timeout: 5_000 });

  // persisted end-state via GET (repo testing rule)
  const resp = await request.get(`${BACKEND}/games/${gameId}/slot-model`);
  expect(resp.ok()).toBeTruthy();
  const doc = (await resp.json()) as { locks?: { reels: boolean; paytable: boolean; bonus: boolean } };
  expect(doc.locks).toEqual({ reels: false, paytable: true, bonus: false });

  // survives reload: fresh page, fresh hydrate from the store
  await page.reload();
  await expect(page.getByTestId('room-picker')).toBeVisible();
  await page.getByTestId('room-picker').getByText(roomName, { exact: true }).click();
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
  await openGameConfig(page);
  await expect(page.getByTestId('gc-tab-lock-paytable')).toBeVisible();
  await page.getByTestId('gc-tab-paytable').click();
  await expect(page.getByTestId('gc-lock-paytable')).toContainText('Locked');
});

test('apply template overwrites unlocked sections and keeps locked ones', async ({ page, request }) => {
  const gameId = await setupGame(page, request, 'jon', `gc ${Date.now()}`);
  await openGameConfig(page);
  await page.getByTestId('gc-tab-paytable').click();
  await page.getByTestId('gc-lock-paytable').click();
  await expect(page.getByTestId('gc-sync-pill')).toContainText('saved', { timeout: 5_000 });

  await page.getByTestId('gc-apply-template').click();
  await page.getByTestId('gc-template-select').selectOption('video-5x3');
  await expect(page.getByTestId('gc-template-protected')).toContainText('paytable');
  await page.getByTestId('gc-template-confirm').click();

  // template landed and the pane reconciled: video-5x3 is 5 reels x 3 rows
  await expect(page.getByTestId('gc-stat-window')).toHaveText('3 × 5', { timeout: 5_000 });

  const doc = await getModelDoc(request, gameId);
  expect(doc.model.reels).toHaveLength(5); // overwritten by the template
  expect(doc.model.paytable.entries).toEqual(MODEL.paytable.entries); // lock-protected
});
```

- [ ] **Step 2: Run the two tests against the replay stack**

From Git Bash at the **worktree** root, with the worktree's offset:

```bash
export BLOOM_PORT_OFFSET=1
just backend-serve-replay   # terminal 1 (or run in background); backend on :8001
just e2e -- --grep "padlock|apply template"   # terminal 2
```

(If `just e2e` doesn't forward args, run `npx playwright test e2e/game-config.spec.ts` from `studio/frontend` with `BLOOM_PORT_OFFSET=1` exported.)
Expected: both PASS.

- [ ] **Step 3: Run the FULL e2e suite** (repo rule: before every PR)

```bash
export BLOOM_PORT_OFFSET=1
just e2e
```

Expected: entire suite green (baseline was 86 green after PR #125; PR #140 kept it green). Any red in an untouched spec: investigate before assuming pre-existing — likely a real regression from this branch.

- [ ] **Step 4: Backend + Rust + frontend gates one last time**

- `studio/backend`: `uv run pytest`
- repo root: `cargo test --workspace && cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings`
- repo root: `node_modules/.bin/prettier --check . && npx nx typecheck frontend && npx nx test frontend && npx nx build frontend`

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/e2e/game-config.spec.ts
git commit -m "test(game-config): e2e for padlock persistence + lock-aware apply-template"
```

---

### Task 9 (OPTIONAL, TIME-BOXED): issue #142 — re-freeze high-vol-5x4 from a product-shaped seed

Skip cleanly if the time-box blows: revert with `git checkout -- studio/backend/app/math/templates.py` and leave #142 open. Everything else in this plan is independent of this task.

**Files:**

- Modify: `studio/backend/tools/freeze_template.py` (accept lock args — dogfoods this branch's feature)
- Modify: `studio/backend/app/math/templates.py` (`_HIGH_VOL_5X4`)

**Interfaces:**

- Consumes: `build_config(params, bounds, locks)` (Task 4); the lock-honoring binary (Tasks 1–3).
- Produces: a high-vol-5x4 template whose paytable is hand-shaped (graduated tiers, real jackpot, meaningful bonus) and **locked during the freeze**, so the GA can only reshape reels — the exact failure mode of the current template (GA-overfit flat-1 paytable) becomes impossible.

- [ ] **Step 1: Teach freeze_template.py locks**

Change `main` and the entrypoint (`tools/freeze_template.py:43-64`):

```python
async def main(name: str, lock_names: list[str]) -> None:
    seed = templates.get_model(name)
    target = TEMPLATE_TARGETS[name]
    params = default_tuning_params().model_copy(update={"max_generations": 160})
    locks = SectionLocks(**{n: True for n in lock_names})
    config = build_config(params, derive_bounds(seed), locks)
```

with `from app.math.models import SectionLocks, default_tuning_params` and
`asyncio.run(main(sys.argv[1], sys.argv[2:]))`, and extend the usage docstring:
`uv run python tools/freeze_template.py high-vol-5x4 paytable bonus > hv.tuned.json  # lock sections against the GA`.

- [ ] **Step 2: Hand-shape the seed**

In `templates.py:_HIGH_VOL_5X4`, replace the flat paytable and token bonus with a graduated, product-shaped seed (keep symbols/reels/paylines/rows as they are — the GA will retune reels):

```python
    "paytable": {"entries": [
        {"symbol": 0, "count": 3, "payout": 1},  {"symbol": 0, "count": 4, "payout": 2},   {"symbol": 0, "count": 5, "payout": 5},
        {"symbol": 1, "count": 3, "payout": 1},  {"symbol": 1, "count": 4, "payout": 3},   {"symbol": 1, "count": 5, "payout": 8},
        {"symbol": 2, "count": 3, "payout": 2},  {"symbol": 2, "count": 4, "payout": 5},   {"symbol": 2, "count": 5, "payout": 15},
        {"symbol": 3, "count": 3, "payout": 4},  {"symbol": 3, "count": 4, "payout": 12},  {"symbol": 3, "count": 5, "payout": 60},
        {"symbol": 4, "count": 3, "payout": 15}, {"symbol": 4, "count": 4, "payout": 60},  {"symbol": 4, "count": 5, "payout": 400},
    ]},
    "bonuses": [{
        "FreeSpins": {
            "trigger": {"symbol": 9, "min_count": 4},
            "config": {"spins_awarded": 8, "retrigger": False,
                       "multiplier": 2, "feature_reels": None},
        },
    }],
```

- [ ] **Step 3: Freeze with paytable + bonus locked**

From `studio/backend` (cargo toolchain on PATH; release binary built):

```bash
uv run python tools/freeze_template.py high-vol-5x4 paytable bonus > hv.tuned.json
```

The GA now only reshapes reels toward RTP 0.96±0.01 / vol ≥ 10 / bonus HR 1:200±25% (`TEMPLATE_TARGETS`). If it ends `near_miss`, nudge and repeat — scale the whole paytable tier structure (e.g. premium column ×1.2) or the scatter density in the seed reels, **keeping the shape graduated**. Time-box: 3 nudge attempts.

- [ ] **Step 4: Paste + verify**

Paste the tuned model into `_HIGH_VOL_5X4` (the paytable/bonus come back verbatim — they were locked), update the comment block with the new measured metrics and the freeze command used, delete `hv.tuned.json`, then:

```bash
uv run pytest tests/test_math_templates_binary.py -m e2e -k high_vol
```

Expected: PASS at the stated target. Also re-run `uv run pytest` (unit) — nothing else reads the literal.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/tools/freeze_template.py studio/backend/app/math/templates.py
git commit -m "feat(math): product-shaped high-vol-5x4 template, frozen with locked paytable (#142)"
```

---

## Completion

Standard flow: push + PR (never a merge-options menu):

```bash
git push -u origin feat/math-locks
gh pr create --title "feat(math): section locks + templates UI (SP2)" --body "..."
```

PR body should note: closes #141, closes #142 (if Task 9 landed), spec reference, and that all routes/events/tool names are preserved. After merge: `/bloom:complete-work` (or the manual worktree cleanup ritual from AGENTS.md).

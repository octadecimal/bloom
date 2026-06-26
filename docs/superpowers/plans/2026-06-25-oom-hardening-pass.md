# OOM Hardening Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every remaining data-dependent OOM hazard in the math stack (Rust crates + the Python orchestration) so a degenerate model or config fails loud instead of exhausting RAM.

**Architecture:** Defense in depth in three rings, extending the pattern PR #96 established (kernel cap + process watchdog): (1) **validate input** — reject absurd sizes before allocation, at the realizer and each Rust binary entry; (2) **bound algorithms** — keep the kernel free-spins cap, make realizer payline generation lazy; (3) **watchdog** — port the simulator's process-tree memory/timeout guard to the tuner via a shared helper both runners use.

**Tech Stack:** Rust (`bloom-math`, `bloom-simulator`, `bloom-tuner`), Python 3 + asyncio + psutil (`studio/backend`), pytest, cargo.

## Global Constraints

- **Worktree:** `C:\code\bloom.wt\oom-hardening` on branch `fix/oom-hardening`, based on `main` @ #96. All work happens here. Backend port offset 1 (8001 / 4201) — irrelevant to the unit tests below.
- **TDD mandatory:** every change is RED (failing test) → GREEN (minimal code) → REFACTOR.
- **Conventional Commits:** `<type>(<scope>): <desc>`, imperative mood.
- **Interfaces use `I` prefix** (TS only — not relevant to this Python/Rust plan).
- **Rust gates before PR:** `cargo test`, `cargo fmt --check`, `cargo clippy` for each touched crate (a `cargo fmt`/`clippy` failure fails CI — run locally).
- **Python gate:** `uv run pytest` from `studio/backend` (unit tests; `-m e2e` tests need cargo and stay out of the default gate).
- **Prettier:** docs/`*.md` are checked by the pinned prettier (`node_modules/.bin/prettier`, not `npx`).
- **Ceilings are absurdity bounds, not tuning limits:** they sit far above any honest run (defaults: candidate_count ~2×10⁵, population 24, generations 40). The subprocess watchdog remains the runtime backstop for the gray zone.

---

### Task 1: Verify H1 (kernel free-spins cap) — no code change

**Files:**

- Inspect: `trusted/math/src/mechanics/slots/eval.rs`

**Interfaces:**

- Consumes: nothing.
- Produces: confirmation that `MAX_FREE_SPINS` and its regression test exist (later tasks assume the kernel cap is the last-resort bound).

- [ ] **Step 1: Confirm the cap and the regression test are present**

Run: `git -C . grep -n "MAX_FREE_SPINS" trusted/math/src/mechanics/slots/eval.rs`
Expected: a `pub const MAX_FREE_SPINS: u32 = 1000;`, the loop guard `while remaining > 0 && spins_played < MAX_FREE_SPINS`, and test `supercritical_retrigger_is_capped_not_unbounded`.

- [ ] **Step 2: Run the kernel test to confirm it passes**

Run: `cargo test -p bloom-math supercritical_retrigger_is_capped_not_unbounded -- --nocapture`
Expected: PASS. If it is ever absent/failing, STOP and add a test that builds a supercritical-retrigger model (retrigger=true, trigger easily met every spin) and asserts `out.spins_played == MAX_FREE_SPINS`. (It is present in this worktree; this task is a checkpoint, no commit.)

---

### Task 2: H4 — simulator input ceiling (`bloom_simulator::validate_target`)

A degenerate `candidate_count` / `pool_size` drives `generate_seeds(n)` and `Vec::with_capacity(n)` (in `run.rs`) into an up-front OOM, and `pool_size > candidate_count` panics in `freeze_pool`'s `assert!`. Add an up-front validator (mirrors `bloom_tuner::validate`) and call it from the binary.

**Files:**

- Create: `studio/simulator/src/validate.rs`
- Modify: `studio/simulator/src/lib.rs` (add `pub mod validate;` + re-export)
- Modify: `studio/simulator/src/bin/curate_json.rs` (call the validator in `main`)

**Interfaces:**

- Consumes: `bloom_simulator::target::TargetSpec`.
- Produces: `pub const MAX_CANDIDATE_COUNT: usize = 100_000_000;` and `pub fn validate_target(target: &TargetSpec) -> Result<(), String>`, re-exported as `bloom_simulator::validate_target`.

- [ ] **Step 1: Write the failing test** — create `studio/simulator/src/validate.rs`:

```rust
//! Up-front validation of curation inputs: reject absurd sizes BEFORE they drive
//! an unbounded `generate_seeds` / `Vec::with_capacity` allocation (OOM), and
//! before `freeze_pool`'s `samples.len() >= pool_size` assert can panic. These
//! are absurdity ceilings (defense-in-depth) far above any honest run; the
//! subprocess watchdog is the runtime backstop.

use crate::target::TargetSpec;

/// Largest candidate_count / pool_size we will allocate for. Honest runs are
/// ~10^5–10^6; beyond this is a typo or a degenerate realized config.
pub const MAX_CANDIDATE_COUNT: usize = 100_000_000;

/// `Err(message)` if the target would OOM or panic downstream.
pub fn validate_target(target: &TargetSpec) -> Result<(), String> {
    if target.candidate_count > MAX_CANDIDATE_COUNT {
        return Err(format!(
            "candidate_count {} exceeds MAX_CANDIDATE_COUNT {} (refusing to allocate; retune the run)",
            target.candidate_count, MAX_CANDIDATE_COUNT
        ));
    }
    if target.pool_size > MAX_CANDIDATE_COUNT {
        return Err(format!(
            "pool_size {} exceeds MAX_CANDIDATE_COUNT {}",
            target.pool_size, MAX_CANDIDATE_COUNT
        ));
    }
    if target.pool_size > target.candidate_count {
        return Err(format!(
            "pool_size {} exceeds candidate_count {} (cannot freeze a pool larger than the candidate sample)",
            target.pool_size, target.candidate_count
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::target::TargetSpec;

    fn target(candidate_count: usize, pool_size: usize) -> TargetSpec {
        TargetSpec {
            rtp_target: 0.96,
            rtp_tolerance: 0.01,
            volatility_min: 0.0,
            volatility_max: 1e9,
            bonus_hit_rate_bands: vec![],
            pool_size,
            candidate_count,
            realized_correction_band: 0.05,
        }
    }

    #[test]
    fn ok_for_an_honest_run() {
        assert!(validate_target(&target(200_000, 10_000)).is_ok());
    }

    #[test]
    fn rejects_oversized_candidate_count() {
        let err = validate_target(&target(MAX_CANDIDATE_COUNT + 1, 1)).unwrap_err();
        assert!(err.contains("candidate_count"));
    }

    #[test]
    fn rejects_pool_larger_than_candidates() {
        let err = validate_target(&target(1_000, 2_000)).unwrap_err();
        assert!(err.contains("exceeds candidate_count"));
    }
}
```

- [ ] **Step 2: Wire the module** — in `studio/simulator/src/lib.rs`, add the module and re-export. The current module list ends with `pub mod target;`. Add after it:

```rust
pub mod validate;

pub use validate::validate_target;
```

- [ ] **Step 3: Run the test to verify it fails (then passes once compiled)**

Run: `cargo test -p bloom-simulator validate`
Expected: compiles and the three `validate::tests` PASS. (The test file and impl are added together because Rust will not compile a module that references a missing function; this is the smallest compilable unit.)

- [ ] **Step 4: Call the validator from the binary** — in `studio/simulator/src/bin/curate_json.rs`, immediately after the `let target = TargetSpec { ... };` block and before `let signing_key = ...`, insert:

```rust
    if let Err(e) = bloom_simulator::validate_target(&target) {
        eprintln!("invalid target: {e}");
        std::process::exit(2);
    }
```

- [ ] **Step 5: Verify the crate builds and all simulator tests pass**

Run: `cargo test -p bloom-simulator`
Expected: PASS (existing curation tests unaffected — they all use `pool_size <= candidate_count`).

- [ ] **Step 6: Format, lint, commit**

```bash
cargo fmt -p bloom-simulator
cargo clippy -p bloom-simulator -- -D warnings
git add studio/simulator/src/validate.rs studio/simulator/src/lib.rs studio/simulator/src/bin/curate_json.rs
git commit -m "fix(simulator): reject absurd candidate_count/pool_size before allocation (OOM)"
```

---

### Task 3: H4 — tuner input ceilings (extend `bloom_tuner::validate`)

`tune_json.rs` already calls `bloom_tuner::validate`. Add size ceilings there so a degenerate `population` / `max_generations` / `*_candidate_count` fails loud instead of OOMing in the GA.

**Files:**

- Modify: `studio/tuner/src/validate.rs` (add ceilings + tests)

**Interfaces:**

- Consumes: `crate::config::TunerConfig`.
- Produces: new `pub const`s `MAX_POPULATION`, `MAX_GENERATIONS`, `MAX_CANDIDATE_COUNT`; extends existing `validate(...)` (signature unchanged).

- [ ] **Step 1: Write the failing tests** — append to the `tests` module in `studio/tuner/src/validate.rs` (before the closing `}`):

```rust
    #[test]
    fn rejects_oversized_population() {
        let mut c = cfg();
        c.population = MAX_POPULATION + 1;
        assert!(validate(&model(1), &target(1), &c)
            .unwrap_err()
            .contains("population"));
    }

    #[test]
    fn rejects_oversized_generations() {
        let mut c = cfg();
        c.max_generations = MAX_GENERATIONS + 1;
        assert!(validate(&model(1), &target(1), &c)
            .unwrap_err()
            .contains("max_generations"));
    }

    #[test]
    fn rejects_oversized_candidate_count() {
        let mut c = cfg();
        c.search_candidate_count = MAX_CANDIDATE_COUNT + 1;
        assert!(validate(&model(1), &target(1), &c)
            .unwrap_err()
            .contains("search_candidate_count"));
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p bloom-tuner validate`
Expected: FAIL to compile (`MAX_POPULATION` etc. not found).

- [ ] **Step 3: Add the constants and checks** — at the top of `studio/tuner/src/validate.rs`, after the `use` lines, add:

```rust
/// Absurdity ceilings: far above any honest tune (defaults: population 24,
/// generations 40, candidate counts ~10^4–10^5). Reject beyond these BEFORE the
/// GA allocates `generate_seeds(count)` / a population vector and OOMs.
pub const MAX_POPULATION: usize = 1_000_000;
pub const MAX_GENERATIONS: usize = 1_000_000;
pub const MAX_CANDIDATE_COUNT: usize = 100_000_000;
```

Then inside `validate`, immediately before `Ok(())`, add:

```rust
    if cfg.population > MAX_POPULATION {
        return Err(format!(
            "population {} exceeds MAX_POPULATION {}",
            cfg.population, MAX_POPULATION
        ));
    }
    if cfg.max_generations > MAX_GENERATIONS {
        return Err(format!(
            "max_generations {} exceeds MAX_GENERATIONS {}",
            cfg.max_generations, MAX_GENERATIONS
        ));
    }
    if cfg.search_candidate_count > MAX_CANDIDATE_COUNT {
        return Err(format!(
            "search_candidate_count {} exceeds MAX_CANDIDATE_COUNT {}",
            cfg.search_candidate_count, MAX_CANDIDATE_COUNT
        ));
    }
    if cfg.final_candidate_count > MAX_CANDIDATE_COUNT {
        return Err(format!(
            "final_candidate_count {} exceeds MAX_CANDIDATE_COUNT {}",
            cfg.final_candidate_count, MAX_CANDIDATE_COUNT
        ));
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p bloom-tuner validate`
Expected: PASS (new + existing `ok_when_counts_match_and_bounds_sane`, which uses small values).

- [ ] **Step 5: Format, lint, commit**

```bash
cargo fmt -p bloom-tuner
cargo clippy -p bloom-tuner -- -D warnings
git add studio/tuner/src/validate.rs
git commit -m "fix(tuner): reject absurd population/generations/candidate counts (OOM)"
```

---

### Task 4: H3 — realizer geometry guard + lazy lines-mode paylines

"lines" mode calls `_all_patterns`, which materializes the full `rows^reel_count` product before slicing `[:n]`. Reels/rows are unbounded GDD inputs → Python OOM. Fix: a geometry ceiling at the entry point, and lazy first-`n` generation that never materializes the full product.

**Files:**

- Modify: `studio/backend/app/simulator/realize.py`
- Test: `studio/backend/tests/test_realize.py`

**Interfaces:**

- Consumes: nothing new.
- Produces: module consts `MAX_REELS = 12`, `MAX_ROWS = 12`; new `_first_n_patterns(rows: int, reel_count: int, n: int) -> list[list[int]]`; `realize_slot_model` now returns a hard error for oversized geometry. `_all_patterns` is unchanged (ways mode still uses it, bounded by `MAX_PAYLINES`).

- [ ] **Step 1: Write the failing tests** — append to `studio/backend/tests/test_realize.py`. First extend the import line at the top to include `_first_n_patterns`:

```python
from app.simulator.realize import (
    RealizeResult, _realize_symbols, _to_int, _to_bool, _KIND_TO_ROLE,
    _realize_reels, _all_patterns, _first_n_patterns, _realize_paylines,
    _realize_paytable, _realize_bonuses, realize_slot_model,
)
```

Then add these tests at the end of the file:

```python
def test_first_n_patterns_matches_all_patterns_ordering():
    # Lazy generator must produce exactly the same prefix as _all_patterns.
    full = _all_patterns(rows=3, reel_count=5)
    assert _first_n_patterns(3, 5, 5) == full[:5]
    assert _first_n_patterns(3, 5, 1) == full[:1]


def test_paylines_lines_mode_is_lazy_for_huge_geometry():
    import time
    # 12^12 ≈ 8.9e12 combos: a full materialization would OOM/hang. Lazy first-n
    # must return instantly with exactly n lines.
    t0 = time.perf_counter()
    lines, errors, warnings = _realize_paylines(
        {"payline_mode": "lines", "payline_count": 3}, reel_count=12, rows=12)
    assert errors == []
    assert lines == [[0] * 12, [1] * 12, [2] * 12]
    assert time.perf_counter() - t0 < 1.0  # never built 12^12


def test_realize_rejects_oversized_geometry_fast():
    res = realize_slot_model(
        {"reels": 999, "rows": 999, "payline_mode": "lines", "payline_count": 1},
        _GDD_SYMBOLS, _GDD_PAYTABLE, _GDD_BONUS)
    assert res.model is None
    assert any("MAX_REELS" in e for e in res.errors)
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd studio/backend && uv run pytest tests/test_realize.py -k "first_n or lazy or oversized_geometry" -v`
Expected: FAIL — `ImportError` for `_first_n_patterns` (and the geometry test would otherwise hang/OOM, which is exactly what we're fixing).

- [ ] **Step 3: Add `_first_n_patterns`** — in `studio/backend/app/simulator/realize.py`, immediately after `_all_patterns` (after its `return constants + others` line), add:

```python
def _first_n_patterns(rows: int, reel_count: int, n: int) -> list[list[int]]:
    """The first `n` paylines in the same order as `_all_patterns` (constants
    first, then lexicographic), generated LAZILY — never materializes more than
    `n` patterns. "lines" mode uses this so a large rows^reel_count geometry can
    never OOM when only `n` lines are kept."""
    out: list[list[int]] = []
    for r in range(rows):  # constants first
        if len(out) >= n:
            return out
        out.append([r] * reel_count)
    for combo in product(range(rows), repeat=reel_count):  # then non-constants
        if len(out) >= n:
            break
        if len(set(combo)) > 1:
            out.append(list(combo))
    return out
```

- [ ] **Step 4: Use it in lines mode** — in `_realize_paylines`, replace the final line:

```python
    return _all_patterns(rows, reel_count)[:n], errors, warnings
```

with:

```python
    return _first_n_patterns(rows, reel_count, n), errors, warnings
```

- [ ] **Step 5: Add the geometry guard** — in `realize_slot_model`, add the constants near the other module consts at the top of the file (after `MAX_PAYLINES = 4096`):

```python
MAX_REELS = 12
MAX_ROWS = 12
```

Then in `realize_slot_model`, after the `rows = _to_int(math_model.get("rows"), DEFAULT_ROWS)` line (and its absent-warning), and BEFORE the `reels, e, w = _realize_reels(...)` call, insert:

```python
    if reel_count > MAX_REELS:
        errors.append(f"reels {reel_count} exceeds MAX_REELS {MAX_REELS}")
    if rows > MAX_ROWS:
        errors.append(f"rows {rows} exceeds MAX_ROWS {MAX_ROWS}")
    if errors:
        return RealizeResult(None, errors, warnings)
```

- [ ] **Step 6: Run the full realizer suite to verify pass + no regressions**

Run: `cd studio/backend && uv run pytest tests/test_realize.py -v`
Expected: PASS — new tests green; existing `test_paylines_lines_mode_takes_first_n`, `test_all_patterns_horizontals_first_then_lexicographic`, `test_paylines_ways_*`, golden vector all still green.

- [ ] **Step 7: Commit**

```bash
git add studio/backend/app/simulator/realize.py studio/backend/tests/test_realize.py
git commit -m "fix(realize): bound geometry + lazily generate lines paylines (OOM)"
```

---

### Task 5: H5 — realizer strip-length clamp

`strip_length.max` flows into `length` and a reel list of that length × reel_count, unbounded. Clamp it.

**Files:**

- Modify: `studio/backend/app/simulator/realize.py`
- Test: `studio/backend/tests/test_realize.py`

**Interfaces:**

- Consumes: nothing new.
- Produces: module const `MAX_STRIP_LEN = 1000`; `_realize_reels` clamps `length` to it with a warning.

- [ ] **Step 1: Write the failing test** — append to `studio/backend/tests/test_realize.py`:

```python
def test_realize_reels_clamps_oversized_strip_length():
    reels, errors, warnings = _realize_reels(
        {"strip_length": {"min": 1_000_000, "max": 1_000_000}}, _normals(4), reel_count=3)
    assert errors == []
    assert all(len(r) == 1000 for r in reels)  # clamped to MAX_STRIP_LEN
    assert any("MAX_STRIP_LEN" in w for w in warnings)
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_realize.py::test_realize_reels_clamps_oversized_strip_length -v`
Expected: FAIL — reels are length 1_000_000, assertion fails (and the allocation is the hazard).

- [ ] **Step 3: Add the constant and clamp** — in `realize.py`, add near the other consts (after `SCATTER_STRIP_SPACING = 20`):

```python
MAX_STRIP_LEN = 1000  # absurdity ceiling for a single reel strip
```

Then in `_realize_reels`, after the `if/else` block that computes `length` (right before `paying = [...]`), insert:

```python
    if length > MAX_STRIP_LEN:
        warnings.append(
            f"strip length {length} exceeds MAX_STRIP_LEN {MAX_STRIP_LEN}; clamped"
        )
        length = MAX_STRIP_LEN
```

- [ ] **Step 4: Run to verify pass + no regressions**

Run: `cd studio/backend && uv run pytest tests/test_realize.py -v`
Expected: PASS (existing strip-length tests use small values, unaffected).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/simulator/realize.py studio/backend/tests/test_realize.py
git commit -m "fix(realize): clamp oversized reel strip length (OOM)"
```

---

### Task 6: H2a — extract the shared subprocess watchdog; refactor the simulator runner

The simulator runner has `_proc_tree_rss_mb`, `_kill_proc_tree`, and an inline `_watchdog`. Extract them into a shared module so the tuner can reuse them (Task 7), and refactor the simulator runner onto it with identical behavior.

**Files:**

- Create: `studio/backend/app/subprocess_guard.py`
- Modify: `studio/backend/app/simulator/runner.py`
- Test: `studio/backend/tests/test_subprocess_guard.py` (new), and existing `tests/test_sim_runner.py` must stay green.

**Interfaces:**

- Consumes: an `asyncio.subprocess.Process` and an `asyncio.Event`.
- Produces: `proc_tree_rss_mb(pid: int) -> float`, `kill_proc_tree(pid: int) -> None`, and `async watch_proc_tree(proc, done, *, label: str, mem_cap_mb: float, timeout_s: float, poll_s: float) -> str | None` (returns the guard-trip message, or `None` if the process finished on its own). The message contains the substrings `"memory"` / `"wall-clock"` so existing runner tests keep matching.

- [ ] **Step 1: Write the failing test** — create `studio/backend/tests/test_subprocess_guard.py`:

```python
import asyncio
import sys

import pytest
from app.subprocess_guard import watch_proc_tree

_MEM_HOG = (
    "import time\n"
    "buf = []\n"
    "for _ in range(20):\n"
    "    buf.append(bytearray(20 * 1024 * 1024))\n"
    "    time.sleep(0.1)\n"
    "time.sleep(2)\n"
)
_SLEEPER = "import time\ntime.sleep(60)\n"
_QUICK = "pass\n"


async def _spawn(script: str):
    return await asyncio.create_subprocess_exec(
        sys.executable, "-c", script,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)


@pytest.mark.asyncio
async def test_watch_trips_on_memory():
    proc = await _spawn(_MEM_HOG)
    done = asyncio.Event()
    msg = await watch_proc_tree(
        proc, done, label="curation", mem_cap_mb=120.0, timeout_s=30.0, poll_s=0.05)
    await proc.wait()
    assert msg is not None and "memory" in msg.lower()


@pytest.mark.asyncio
async def test_watch_trips_on_wall_clock():
    proc = await _spawn(_SLEEPER)
    done = asyncio.Event()
    msg = await watch_proc_tree(
        proc, done, label="tuning", mem_cap_mb=8192.0, timeout_s=0.5, poll_s=0.05)
    await proc.wait()
    assert msg is not None and "wall-clock" in msg.lower()


@pytest.mark.asyncio
async def test_watch_returns_none_when_process_finishes():
    proc = await _spawn(_QUICK)
    done = asyncio.Event()
    # Drain + signal done when the child exits, like a real runner does.
    async def _drain():
        await proc.stdout.read()
        done.set()
    msg, _ = await asyncio.gather(
        watch_proc_tree(proc, done, label="curation",
                        mem_cap_mb=8192.0, timeout_s=30.0, poll_s=0.05),
        _drain())
    await proc.wait()
    assert msg is None
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_subprocess_guard.py -v`
Expected: FAIL — `ModuleNotFoundError: app.subprocess_guard`.

- [ ] **Step 3: Create the shared module** — `studio/backend/app/subprocess_guard.py`:

```python
"""Shared runaway-guard for math subprocesses (curate_json / tune_json). A
numerically-degenerate model can drive the kernel into unbounded memory; the
watchdog polls the subprocess tree and hard-kills it the instant resident memory
or wall-clock crosses a cap. Used by both the simulator and tuner runners."""
import asyncio

import psutil


def proc_tree_rss_mb(pid: int) -> float:
    """Resident memory of the whole process subtree rooted at `pid`, in MiB. Sums
    parent + all descendants (under `cargo run` the real binary is a grandchild).
    Returns 0.0 if the tree has already gone."""
    try:
        root = psutil.Process(pid)
        procs = [root, *root.children(recursive=True)]
    except psutil.NoSuchProcess:
        return 0.0
    total = 0
    for p in procs:
        try:
            total += p.memory_info().rss
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    return total / (1024 * 1024)


def kill_proc_tree(pid: int) -> None:
    """Hard-kill the subtree rooted at `pid` (descendants first, then the root) so
    a runaway can never outlive the guard or keep eating RAM."""
    try:
        root = psutil.Process(pid)
        procs = [*root.children(recursive=True), root]
    except psutil.NoSuchProcess:
        return
    for p in procs:
        try:
            p.kill()
        except psutil.NoSuchProcess:
            pass
    psutil.wait_procs(procs, timeout=5)


async def watch_proc_tree(
    proc, done: asyncio.Event, *,
    label: str, mem_cap_mb: float, timeout_s: float, poll_s: float,
) -> str | None:
    """Poll the subprocess tree until `done` is set; hard-kill it and return a
    guard-trip message the instant resident memory or wall-clock crosses a cap.
    Returns None if the process finished on its own. `label` names the operation
    in the message (e.g. "curation", "tuning"). A fast runaway (the kernel can hit
    GBs in a fraction of a second) is caught by the memory cap; the timeout is a
    backstop for a stuck process."""
    loop = asyncio.get_event_loop()
    start = loop.time()
    while not done.is_set():
        try:
            await asyncio.wait_for(done.wait(), timeout=poll_s)
            return None  # process finished on its own
        except asyncio.TimeoutError:
            pass
        rss = proc_tree_rss_mb(proc.pid)
        elapsed = loop.time() - start
        if rss > mem_cap_mb:
            msg = (f"{label} aborted: subprocess memory {rss:.0f}MiB exceeded "
                   f"cap {mem_cap_mb:.0f}MiB (runaway model); process killed")
        elif elapsed > timeout_s:
            msg = (f"{label} aborted: subprocess ran longer than "
                   f"{timeout_s:.0f}s wall-clock; process killed")
        else:
            continue
        kill_proc_tree(proc.pid)
        done.set()
        return msg
    return None
```

- [ ] **Step 4: Run the shared-module tests to verify pass**

Run: `cd studio/backend && uv run pytest tests/test_subprocess_guard.py -v`
Expected: PASS (all three).

- [ ] **Step 5: Refactor the simulator runner onto the shared helper** — in `studio/backend/app/simulator/runner.py`:

(a) Delete the two module-level functions `_proc_tree_rss_mb` and `_kill_proc_tree` entirely.

(b) Add the import near the top (after `import psutil` — which can now be removed from this file if no longer referenced; leave it if `psutil` is used elsewhere here, it is not, so remove it):

```python
from app.subprocess_guard import watch_proc_tree
```

(c) Replace the inline `_watchdog` coroutine in `run()` with a thin wrapper that delegates. The existing `async def _watchdog()` (the whole `nonlocal guard_trip` polling loop) becomes:

```python
            async def _watchdog() -> None:
                nonlocal guard_trip
                guard_trip = await watch_proc_tree(
                    proc, done, label="curation",
                    mem_cap_mb=self._mem_cap_mb, timeout_s=self._timeout_s,
                    poll_s=self._poll_s)
```

Leave everything else (`_drain_stdout` setting `done.set()`, the `asyncio.gather(_drain_stdout(), proc.stderr.read(), _watchdog())`, and the `if guard_trip is not None:` branch) unchanged.

- [ ] **Step 6: Run the simulator runner tests to verify no regression**

Run: `cd studio/backend && uv run pytest tests/test_sim_runner.py -v`
Expected: PASS — `test_guard_kills_runaway_memory_and_returns_error` (matches "memory"), `test_guard_kills_on_wall_clock_timeout` (matches "wall-clock"), and `test_guard_does_not_trip_for_a_well_behaved_child` all still green.

- [ ] **Step 7: Commit**

```bash
git add studio/backend/app/subprocess_guard.py studio/backend/app/simulator/runner.py studio/backend/tests/test_subprocess_guard.py
git commit -m "refactor(backend): extract shared subprocess watchdog; reuse in simulator runner"
```

---

### Task 7: H2b — add the watchdog (and caps) to the tuner runner

The tuner runner drives the same `evaluate()` over GA-mutated models but has no memory/timeout backstop. Add the settings and wire in the shared watchdog.

**Files:**

- Modify: `studio/backend/app/config.py` (new settings)
- Modify: `studio/backend/app/tuner/runner.py` (guard knobs + watchdog)
- Test: `studio/backend/tests/test_tuner_runner.py` (new)

**Interfaces:**

- Consumes: `app.subprocess_guard.watch_proc_tree` (Task 6).
- Produces: `Settings.tuner_mem_cap_mb: float`, `Settings.tuner_timeout_s: float`; `SubprocessTunerRunner` gains `_mem_cap_mb` / `_timeout_s` / `_poll_s` and returns `TuneResult(status="error", failure=<guard message>)` on a trip.

- [ ] **Step 1: Write the failing tests** — create `studio/backend/tests/test_tuner_runner.py`:

```python
import sys
from types import SimpleNamespace

import pytest
from app.tuner.runner import SubprocessTunerRunner


def _runner(*, mem_cap_mb=4096.0, timeout_s=600.0, poll_s=0.05):
    r = SubprocessTunerRunner(SimpleNamespace(tuner_bin=""))
    r._mem_cap_mb = mem_cap_mb
    r._timeout_s = timeout_s
    r._poll_s = poll_s
    return r


_MEM_HOG = (
    "import time\n"
    "buf = []\n"
    "for _ in range(20):\n"
    "    buf.append(bytearray(20 * 1024 * 1024))\n"
    "    time.sleep(0.1)\n"
    "time.sleep(2)\n"
)
_SLEEPER = "import time\ntime.sleep(60)\n"


def _cmd_for(script: str):
    return lambda *_a, **_k: [sys.executable, "-c", script]


@pytest.mark.asyncio
async def test_tuner_guard_kills_runaway_memory_and_returns_error():
    runner = _runner(mem_cap_mb=120.0, timeout_s=30.0)
    runner._command = _cmd_for(_MEM_HOG)
    res = await runner.run({"m": 1}, {"t": 1}, {"c": 1}, on_progress=lambda _p: None)
    assert res.status == "error"
    assert "memory" in res.failure.lower()


@pytest.mark.asyncio
async def test_tuner_guard_kills_on_wall_clock_timeout():
    runner = _runner(mem_cap_mb=8192.0, timeout_s=0.5)
    runner._command = _cmd_for(_SLEEPER)
    res = await runner.run({"m": 1}, {"t": 1}, {"c": 1}, on_progress=lambda _p: None)
    assert res.status == "error"
    assert "wall-clock" in res.failure.lower()
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd studio/backend && uv run pytest tests/test_tuner_runner.py -v`
Expected: FAIL — `SubprocessTunerRunner.__init__` has no `_mem_cap_mb`, and `run` has no watchdog, so the hog is never killed (the test will fail by timeout/assertion, not pass).

- [ ] **Step 3: Add the settings** — in `studio/backend/app/config.py`, after the `curation_timeout_s` line, add:

```python
    tuner_mem_cap_mb: float = 1024.0  # resident-memory cap for the tuner proc tree
    tuner_timeout_s: float = 120.0  # wall-clock cap (backstop)
```

- [ ] **Step 4: Add guard knobs to the tuner runner** — in `studio/backend/app/tuner/runner.py`, replace `SubprocessTunerRunner.__init__`:

```python
    def __init__(self, settings):
        self._bin = getattr(settings, "tuner_bin", "") or ""
        # Runaway guard: the GA drives the same kernel evaluate() over mutated
        # models. The watchdog polls the subprocess tree and hard-kills it if
        # either bound is crossed (mirrors the simulator runner).
        self._mem_cap_mb = float(getattr(settings, "tuner_mem_cap_mb", 1024.0) or 1024.0)
        self._timeout_s = float(getattr(settings, "tuner_timeout_s", 120.0) or 120.0)
        self._poll_s = 0.1
```

- [ ] **Step 5: Wire the watchdog into `run`** — in `studio/backend/app/tuner/runner.py`:

(a) Add the import near the top (after the existing `from app.tuner.models import ...`):

```python
from app.subprocess_guard import watch_proc_tree
```

(b) In `run()`, after `result: TuneResult | None = None`, add the guard state and event:

```python
            guard_trip: str | None = None
            done = asyncio.Event()
```

(c) At the end of the `_drain_stdout` coroutine (after its `async for` loop), set the event:

```python
                done.set()
```

(d) Add the watchdog coroutine just before the `assert proc.stderr is not None` line:

```python
            async def _watchdog() -> None:
                nonlocal guard_trip
                guard_trip = await watch_proc_tree(
                    proc, done, label="tuning",
                    mem_cap_mb=self._mem_cap_mb, timeout_s=self._timeout_s,
                    poll_s=self._poll_s)
```

(e) Replace the gather line:

```python
            _, stderr_bytes = await asyncio.gather(_drain_stdout(), proc.stderr.read())
```

with:

```python
            _, stderr_bytes, _ = await asyncio.gather(
                _drain_stdout(), proc.stderr.read(), _watchdog())
```

(f) After `await proc.wait()`, before the `if result is None:` block, add the guard-trip branch:

```python
            if guard_trip is not None:
                return TuneResult(
                    status="error", verdict=None, tuned_model=None, metrics=None,
                    missed=[], trace=[], failure=guard_trip, ran_at=ran_at,
                )
```

- [ ] **Step 6: Run to verify the new tests pass**

Run: `cd studio/backend && uv run pytest tests/test_tuner_runner.py -v`
Expected: PASS (both).

- [ ] **Step 7: Commit**

```bash
git add studio/backend/app/config.py studio/backend/app/tuner/runner.py studio/backend/tests/test_tuner_runner.py
git commit -m "fix(tuner): add subprocess memory/timeout watchdog to the tuner runner (OOM)"
```

---

### Task 8: Final verification, gates, and spec status

**Files:**

- Modify: `docs/superpowers/specs/2026-06-25-oom-hardening-pass-design.md` (flip statuses to implemented)

- [ ] **Step 1: Run all Rust gates across the three crates**

Run: `cargo test -p bloom-math -p bloom-simulator -p bloom-tuner && cargo fmt --check && cargo clippy --workspace -- -D warnings`
Expected: all PASS / clean. (If `cargo fmt --check` flags anything, run `cargo fmt` and amend the relevant commit.)

- [ ] **Step 2: Run the full Python unit suite**

Run: `cd studio/backend && uv run pytest -q`
Expected: PASS (the new guard/realizer/runner tests plus all existing unit tests; `-m e2e` tests are not collected by default).

- [ ] **Step 3: Run the browser e2e against a replay backend (authoritative client check)**

Per `AGENTS.md`, start `just backend-serve-replay` (offset-1 ports for this worktree), then `just e2e`.
Expected: green. This confirms the simulator/tuner studio flows still work end-to-end after the runner refactor.

- [ ] **Step 4: Update the spec statuses** — in `docs/superpowers/specs/2026-06-25-oom-hardening-pass-design.md`, change the H2–H5 rows' Status column from "Open" to "Done (this PR)", leaving H1 (Fixed #96) and H6 (Dropped) as-is.

- [ ] **Step 5: Format docs and commit**

```bash
node_modules/.bin/prettier --write docs/superpowers/specs/2026-06-25-oom-hardening-pass-design.md
git add docs/superpowers/specs/2026-06-25-oom-hardening-pass-design.md
git commit -m "docs: mark OOM hazards H2–H5 hardened"
```

- [ ] **Step 6: Push and open the PR**

```bash
git push -u origin fix/oom-hardening
gh pr create --fill
```

---

## Self-Review

**Spec coverage:**

- H1 (kernel cap) → Task 1 (verify-only). ✓
- H2 (tuner watchdog) → Tasks 6 (shared helper + simulator refactor) + 7 (tuner runner). ✓
- H3 (realizer payline materialization) → Task 4. ✓
- H4 (config-driven allocation) → Task 2 (simulator) + Task 3 (tuner). ✓
- H5 (strip length) → Task 5. ✓
- H6 (stderr read) → out of scope by design; spec status unchanged (Task 8 Step 4). ✓
- Prerequisite (fast-forward / worktree off #96) → done before planning. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; every run step shows the command and expected outcome. ✓

**Type/name consistency:** `validate_target` (simulator) vs `validate` (tuner) — distinct, matches each crate's existing export style (`bloom_tuner::validate` already exists; `bloom_simulator::validate_target` is new and re-exported in Task 2 Step 2). `_first_n_patterns(rows, reel_count, n)` defined in Task 4 Step 3, imported in Task 4 Step 1, used in Task 4 Step 4. `watch_proc_tree(proc, done, *, label, mem_cap_mb, timeout_s, poll_s)` defined in Task 6 Step 3, consumed identically in Tasks 6 Step 5 and 7 Step 5. Guard messages contain `"memory"`/`"wall-clock"`, matching the assertions in existing `test_sim_runner.py` and the new tuner/guard tests. ✓

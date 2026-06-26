# OOM Hardening Pass — Design

**Date:** 2026-06-25
**Branch:** `fix/oom-hardening` (worktree `C:\code\bloom.wt\oom-hardening`, off `main` @ #96)
**Status:** approved design, pending implementation plan

## Problem

The Rust math stack — and the Python that drives it — has crashed with
system out-of-memory, most visibly via `curate_json.exe`. The root cause of the
original crash (an unbounded free-spins retrigger loop in the kernel) was fixed
in **PR #96**. This pass is a **full sweep for the same hazard family** —
data-dependent unbounded growth/allocation — across all three Rust crates
(`trusted/math`, `studio/simulator`, `studio/tuner`) and the Python orchestration
that spawns and consumes them, hardening every instance found. OOM crashes have
caused significant workflow friction; the goal is that a degenerate model or
config **fails loud instead of exhausting RAM**.

## Scope

In scope: OOM hazards only (memory exhaustion from unbounded growth or
allocation). Out of scope: correctness of metrics, performance tuning, and any
unrelated refactor. One PR.

## Hazard inventory

All instances share one family: **data-dependent unbounded growth/allocation**.

| #   | Location                                                                                                      | Hazard                                                                                                                                                                                                                                                                                                 | Severity   | Status                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | `trusted/math/src/mechanics/slots/eval.rs` `run_free_spins`                                                   | Supercritical retrigger grows `spins` Vec forever.                                                                                                                                                                                                                                                     | —          | **Fixed (#96)**: `MAX_FREE_SPINS=1000` cap + `saturating_add` + regression test `supercritical_retrigger_is_capped_not_unbounded`. Verify-only. |
| H2  | `studio/backend/app/tuner/runner.py`                                                                          | Tuner subprocess has **no watchdog / mem-cap / timeout**; the simulator runner (`app/simulator/runner.py`) has all three. The GA drives the same `evaluate()` over mutated models and can mutate _into_ degenerate retriggers, with unbounded config allocations and no process-level backstop.        | **High**   | Done — this PR                                                                                                                                  |
| H3  | `studio/backend/app/simulator/realize.py` `_all_patterns` / `_realize_paylines`                               | "lines" mode materializes the **full** `rows^reel_count` product (`list(product(range(rows), repeat=reel_count))`) _before_ slicing `[:n]`. The `MAX_PAYLINES=4096` guard only covers "ways" mode; `reel_count`/`rows` are unbounded GDD inputs. A GDD with e.g. reels=12 OOMs Python in the realizer. | **High**   | Done — this PR                                                                                                                                  |
| H4  | `studio/simulator/src/bin/curate_json.rs`, `studio/tuner/src/bin/tune_json.rs`, `studio/simulator/src/run.rs` | `candidate_count`, `pool_size`, `population`, `search/final_candidate_count`, `max_generations` deserialized from JSON with **no ceiling**; drive `Vec::with_capacity(n)` / `generate_seeds(n)` up-front. An allocation spike can outrun the watchdog's 0.1 s poll; the tuner has no watchdog at all.  | **Medium** | Done — this PR                                                                                                                                  |
| H5  | `studio/backend/app/simulator/realize.py` `_realize_reels`                                                    | `strip_length.max` → `length` → a reel list of `length` ints × `reel_count`, unbounded.                                                                                                                                                                                                                | **Low**    | Done — this PR                                                                                                                                  |
| H6  | both runners                                                                                                  | `proc.stderr.read()` reads all stderr into memory unbounded.                                                                                                                                                                                                                                           | **Low**    | **Dropped (YAGNI)**: cargo logs are small and bounded in practice; documented as accepted.                                                      |

### Implementation note (this PR)

H2–H5 landed on `fix/oom-hardening`. One value changed from this design during
implementation: the tuner's memory-cap **default** is **4096 MiB**, not the 1024
MiB the H2 section first proposed. An honest tune's `cargo run` process tree
peaks ~1.2 GiB, so 1024 MiB killed legitimate tunes; 4096 MiB clears the honest
peak with headroom while still catching an unbounded runaway (which grows to many
GB). The simulator's `curation_mem_cap_mb` default stays 1024 MiB — curation's
working set is far smaller.

### Prerequisite (done)

Local `main` was 2 commits behind `origin/main` and did not contain #96. It has
been fast-forwarded; this worktree branches from #96. No fix is missing — the
"stale" state was only the un-pulled local checkout.

## Approach: defense in depth (three rings)

Extend exactly the pattern #96 established — kernel cap **plus** process
watchdog — consistently across both subprocess paths, and add a thin input-
validation ring so processes reject degenerate input before allocating:

1. **Validate input** — clamp/reject degenerate configs at the realizer and each
   binary entry, loudly, _before_ allocation.
2. **Bound algorithms** — keep the kernel cap (H1); make realizer paylines lazy
   and bounded (H3).
3. **Watchdog** — port the simulator's process-tree mem/timeout guard to the
   tuner (H2).

Rejected alternatives: **watchdog-only** (a 0.1 s RSS poll can't catch an instant
`with_capacity(huge)` spike, and does nothing for in-process Python realizer
OOM); **validation-only** (loses the unforeseen-runaway backstop that was #96's
whole point).

## Design by hazard

### H1 — verify only

Confirm (already true in this worktree) that `MAX_FREE_SPINS` caps the loop and
the regression test exists. No code change. If the test were ever missing, add
one that drives a supercritical-retrigger model and asserts termination at the
cap.

### H2 — port the watchdog to the tuner runner

The simulator runner already has `_proc_tree_rss_mb`, `_kill_proc_tree`, and the
`_watchdog` coroutine. **Extract these into a shared helper module** (e.g.
`app/subprocess_guard.py`) that both runners import — this removes the
duplication rather than copy-pasting. Then:

- Add settings `tuner_mem_cap_mb` (default 1024.0) and `tuner_timeout_s`
  (default 120.0) to `app/config.py`, mirroring `curation_*`. (Consider renaming
  to shared `subprocess_mem_cap_mb` / `subprocess_timeout_s` if both paths want
  the same default; keep separate keys if independent tuning is desired —
  decided in the plan.)
- Wire the watchdog as the third task in the tuner runner's `asyncio.gather`,
  returning a clean `status="error"` with the guard-trip message on kill,
  exactly as the simulator runner does.

### H3 — bound + lazy paylines in the realizer

- Add `MAX_REELS` and `MAX_ROWS` ceilings (and/or a combined
  `rows ** reel_count` ceiling checked _before_ any product is built) to
  `realize.py`. Oversized geometry returns a structural `RealizeResult(None,
errors=[…])` — the realizer's existing fail-loud contract — never a
  materialization.
- In "lines" mode, generate only the first `n` patterns lazily
  (`itertools.islice` over the `product` generator) instead of materializing the
  full product then slicing. `_all_patterns` is refactored so constants-first
  ordering is preserved without holding the whole product in memory, **or**
  "lines" mode bypasses `_all_patterns` and streams directly. (Exact shape
  decided in the plan; the contract is: never materialize more than the bound.)

### H4 — clamp config at the binary entry

In `curate_json.rs` and `tune_json.rs`, validate the size-driving fields against
sane maxima immediately after deserialization and **exit `2` with a clear
message** rather than letting `Vec::with_capacity` / `generate_seeds` OOM.
Candidate ceilings (finalized in the plan): `candidate_count`, `pool_size`,
`population`, `search_candidate_count`, `final_candidate_count`,
`max_generations`. These are defense-in-depth: honest runs are far below them.

### H5 — cap strip length in the realizer

Clamp the realized `length` in `_realize_reels` to a `MAX_STRIP_LEN` with a
warning, so an oversized `strip_length.max` can't allocate an enormous reel.

### H6 — accepted, no change

Documented as low-risk and out of scope; cargo/stderr output is bounded in
practice.

## Testing

TDD throughout — RED degenerate-input test → GREEN bound → REFACTOR:

- **H2:** a fake/stub runaway subprocess (allocates or sleeps past the cap) is
  hard-killed and the tuner runner returns `status="error"` with the guard
  message. Mirrors the existing simulator-runner watchdog tests.
- **H3:** realizer with oversized `reels`/`rows` returns a structural error
  _quickly_ and never materializes the full product (assert error + bound the
  work). "lines" mode with small `n` and large geometry yields exactly `n`
  paylines without OOM.
- **H4:** `curate_json` / `tune_json` given an oversized config exit non-zero
  with the expected message (binary-level test, as in
  `test_sim_curate_binary.py` / `test_tuner_tune_binary.py`).
- **H5:** oversized `strip_length` clamps with a warning.
- **H1:** existing kernel test stands; re-run to confirm.

**Gates before PR:** Rust `cargo test` + `cargo fmt --check` + `cargo clippy`
across the three crates; the Python backend suite; and `just e2e` against the
replay backend (offset-1 ports in this worktree). One PR, one coherent hardening
theme.

## Out of scope / explicitly not doing

- Metric-correctness changes (e.g. whether a capped feature's RTP is "right").
- Performance optimization beyond preventing OOM.
- Any change to the signed package format or the kernel beyond verifying #96.
- Bounding `stderr.read()` (H6).

# Follow-up: unbounded free-spins retrigger → OOM (2026-06-25)

## Symptom

Running the simulator (`curate_json`, reached via `just e2e`, the SP2 parity
test, or any studio curation) intermittently consumed **all system RAM and hung
the OS**. A Python-side memory watchdog was added first, but the machine still
OOM'd: the kernel allocated multiple GB faster than the 100 ms poll could react.

## Root cause

The trusted kernel's free-spins evaluator,
`trusted/math/src/mechanics/slots/eval.rs::run_free_spins`, was **unbounded in
both time and memory**:

```rust
while remaining > 0 {
    remaining -= 1;
    let grid = spin(reels, model.rows, rng);
    payout += eval_grid(model, &grid) * config.multiplier;
    if config.retrigger && count_symbol(&grid, trigger.symbol) >= trigger.min_count {
        remaining += config.spins_awarded;   // no cap
    }
    spins.push(grid);                          // every grid retained
}
```

If a feature's **expected added spins per spin** — `P(retrigger per spin) ×
spins_awarded` — is `≥ 1`, this is a **supercritical branching process**: the
loop never terminates and `spins` grows without bound until the process is
OOM-killed. Because `measure::simulate` runs seeds across rayon threads, several
such evaluations explode in parallel.

The GDD→SlotModel realizer (SP2) produced exactly such a model: it seeded reels
by flat round-robin (`pos % distinct_count`), placing the scatter trigger on
~1-in-4 cells. With a `retrigger=yes`, `spins_awarded=10` bonus that yields
`P(≥3 scatters per spin) ≈ 0.82`, i.e. **8.18 expected added spins per spin** —
wildly supercritical. The model triggered the storm on nearly every seed.

## Fix (defense-in-depth, three layers)

1. **Kernel guardrail (the fundamental fix).**
   `run_free_spins` now caps total spins at `MAX_FREE_SPINS = 1000`
   (`while remaining > 0 && spins_played < MAX_FREE_SPINS`), with
   `saturating_add` on the retrigger counter. The kernel is now **incapable of
   unbounded memory/time for any input**. The bound never binds for an honest
   feature, so every existing golden vector is unchanged.

2. **Realizer no longer emits degenerate models.**
   `realize.py::_realize_reels` lays paying symbols (normal/wild) round-robin and
   sprinkles scatter symbols **sparsely** (~one per `SCATTER_STRIP_SPACING = 20`
   cells). The canonical GDD now realizes to a **subcritical** model: expected
   added spins/spin `8.18 → 0.055`.

3. **Subprocess watchdog (backstop).**
   `SubprocessCurationRunner` polls the process tree's resident memory and
   wall-clock and hard-kills it past `curation_mem_cap_mb` (1024) /
   `curation_timeout_s` (120). Racy by nature (it can't catch a sub-poll
   allocation), so it is the _last_ line of defense, not the fix — layers 1 and 2
   are what make it almost never fire.

## Verification

- `cargo test -p bloom-math` — incl. `supercritical_retrigger_is_capped_not_unbounded`.
- `pytest tests/test_realize.py` — incl. sparse-scatter regression guards.
- `pytest tests/test_sim_runner.py` — bounded mem-hog / timeout / happy-path guard tests.
- `pytest tests/e2e/test_realize_parity.py -m e2e` — realized model deserializes
  and reaches `simulate` in the real binary without OOM.

## Why a const, not a setting (layer 1)

`MAX_FREE_SPINS` lives in the trusted kernel as a hard constant: no input —
model, target, or tuner output — can raise or disable it. A safety bound that
data can turn off is not a safety bound.

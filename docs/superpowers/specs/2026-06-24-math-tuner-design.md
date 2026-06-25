# Bloom — Math Tuner (layer-3, genetic) Design

- **Date:** 2026-06-24
- **Status:** Draft for review
- **Scope:** Build the deferred **layer-3 math tuner** — the optimizer that
  automatically adjusts a slot model's parameters until its measured
  characteristics satisfy a game's design intent. A new headless Rust crate
  `studio/tuner` (`bloom-tuner`): a **genetic algorithm** behind a swappable
  `Tuner` seam that mutates a `SlotModel` and scores it with the existing
  simulator, emitting an interpretable tuned model + an audit trace. This is the
  explicitly-deferred seam from the math-engine spec §8, and the natural sequel to
  the simulator-studio integration (PR #67).
- **Reads first:**
  [`docs/north-star.md`](../../north-star.md) (esp. §6 "AI-designed, never
  AI-decided"),
  the math-engine + simulator design
  [`2026-06-23-math-engine-simulator-design.md`](2026-06-23-math-engine-simulator-design.md)
  (esp. §2.1 Approach A, §5 the pipeline, **§8 the deferred tuner — this effort**),
  the simulator-studio integration design
  [`2026-06-24-simulator-studio-integration-design.md`](2026-06-24-simulator-studio-integration-design.md)
  (esp. §2 intent vs. realization — the loop this tuner closes).

---

## 1. What this delivers (and what it deliberately does not)

The simulator (`studio/simulator`) already **measures** a `SlotModel`'s
characteristics and **verifies** them against a `TargetSpec` — but a model that
misses its targets is, today, a human's problem to fix by hand-editing strips and
re-running. This effort builds the optimizer that closes that loop automatically:

1. **A new `studio/tuner` crate (`bloom-tuner`)** — added to the Cargo workspace,
   depending on `bloom-math` (the certified kernel, read-only) and
   `bloom-simulator` (the fitness function). Nothing depends on it (umbrella
   dependency rule).
2. **A `Tuner` seam** — the swappable layer-3 abstraction math-spec §8 reserved.
   One implementor this slice, `GeneticTuner`.
3. **A genetic algorithm** that mutates a model's **reel composition + paytable
   payouts + bonus config** until its measured RTP / volatility / per-feature
   hit-rates satisfy the target's bands, scoring candidates with the simulator's
   own `measure`.
4. **Interpretable, auditable output** — a tuned `SlotModel` (JSON) plus a
   search-trace report. The regulator audits the final model, never the search.
5. **A thin CLI** (`tune` binary) mirroring the simulator's `curate`, plus a `just`
   recipe.

**Out of scope (deferred, by decision — these are seams, not machinery):**

- **Studio UI / backend wiring / agent tools.** No `studio/frontend` pane, no
  Python `TunerRunner`, no LangGraph tools, no GDD-intent intake. Those are later
  slices that would collide with the active studio-frontend session. This slice is
  a headless crate + CLI only.
- **Freeze / sign.** The tuner **ends at a verified model**; the existing
  `just sim-curate` freezes the faithful pool and signs the package
  (single responsibility — see §7).
- **Mutating game identity.** Symbol set + roles, reel count, rows, and paylines
  stay exactly as authored. The tuner tunes math, not what the game *is*.
- **Strip-order / near-miss (adjacency) tuning** and **separate feature strips.**
  Reels are tuned by composition (per-symbol counts), laid out canonically; tuning
  the *arrangement* within a strip is a later concern (§3).
- **Other tuner strategies** (hill-climb, simulated annealing, CMA-ES, AI
  math-designer agent) and **other mechanics.** The seam makes each additive.

---

## 2. The anchoring decisions

### 2.1 The tuner optimizes model *parameters*, never seed selection

This is the load-bearing invariant from math-spec §8. The tuner mutates a
`SlotModel` (strips / paytable / feature config) and scores each candidate by
**simulating it** through the certified kernel. It **never** touches the seed pool.
Evolving "the ideal list of seeds" is the rejected pool-reshaping approach (§2.1 of
the math spec) in disguise — it detaches pool frequencies from the auditable strips
and produces an opaque, hard-to-certify pool. Faithful sampling (the simulator's
`freeze_pool`) already lands the realized target deterministically; the tuner's job
is strictly upstream of it, on the model.

This invariant is **structurally enforced**, not merely documented: the tuner's
genome decodes to a `SlotModel`, and its fitness is a function of
`measure(simulate(model, seeds))`. There is no code path by which the tuner can
select seeds — the seed set it measures against is a fixed, derived input (§5), not
a thing it optimizes.

### 2.2 AI-designed, never AI-decided

The tuner lives entirely in the **authoring** plane and its output is an
**interpretable `SlotModel`** — the same human-readable strips/paytable a designer
would author by hand. A regulator audits the final strips, not the search that
found them (north-star §6, math-spec §8). The search itself is deterministic and
fully traced (§6), so the run is reproducible and explainable, but the artifact
that matters — and the only thing that could ever cross into the runtime plane —
is the model a human then reviews and signs off. The GA helps a human design a
game; it decides nothing.

### 2.3 The simulator is the fitness function; the tuner is a thin shell

Everything outcome-related stays in the certified core. The tuner does not
re-implement measurement — it calls `bloom_simulator::measure::{simulate, measure}`
and reads `bloom_simulator::target::{Metrics, TargetSpec, HitRateBand}`. The
tuner's only new logic is **search**: genome ↔ model, a fitness scalar, and the GA
loop. This keeps the bit-identical kernel as the single source of outcome truth and
makes the tuned RTP a true promise about live play.

---

## 3. The genome

The genome encodes **only the tunable levers**; game identity stays fixed. It
decodes losslessly to a `SlotModel` that is otherwise identical to the seed model.

| Lever | Encoding | Moves |
| --- | --- | --- |
| **Reel composition** | per reel, a **per-symbol count vector** over a **fixed strip length** (taken from the seed model), laid out in a deterministic **canonical order** | base RTP, volatility, hit-frequency; scatter density → bonus hit-rate |
| **Paytable payouts** | the integer `payout` for each existing `(symbol, count)` entry | base RTP, volatility |
| **Bonus config** | per `FreeSpins` feature: `spins_awarded`, `multiplier`, and the trigger `min_count` | feature RTP, bonus hit-rate |

**Fixed (not genes):** symbol ids/roles, reel count, `rows`, `paylines`,
`paytable` entry *keys* (which `(symbol, count)` rows exist — only their payouts
move), `retrigger`, and `feature_reels` (stays `None`/as-authored).

**Canonical strip layout.** A reel is tuned as a multiset of symbols (how *many* of
each), then laid out in a fixed deterministic order to reconstruct the
`Vec<Symbol>`. This keeps the genome a clean, fixed-length integer vector and makes
the decoded strip deterministic. The *arrangement* within a strip — adjacency,
near-miss design — is **deferred**: for `rows == 1` arrangement is irrelevant, and
for `rows > 1` a canonical layout is a faithful, certifiable starting point that a
later slice can refine into order-aware tuning.

**Bounded integers + repair.** Every gene is a bounded integer; ranges come from
`TunerConfig` (§5). Because crossover/mutation can push a genome out of bounds or
violate a structural constraint (reel counts must sum to the strip length, payouts
≥ 0, `min_count` ≥ 1 and ≤ feasible scatter count), a **repair operator** runs
after every genetic operation and normalizes the genome back into the feasible set.
**No invalid candidate ever reaches the kernel** — `decode` always yields a valid
`SlotModel`. Repair is deterministic.

---

## 4. The objective (fitness)

`verify()` is a boolean PASS/FAIL — it gives the GA no gradient. The tuner therefore
scores a candidate with a **continuous, weighted distance-to-band** scalar:

```
fitness(model) = − Σ_m  w_m · d_m
```

where, for each metric `m` ∈ {RTP, volatility, each per-feature hit-rate}, `d_m` is
the metric's **normalized distance OUTSIDE its band** — 0 when the measured value is
inside the band, otherwise the gap to the nearest band edge divided by a
normalizer (band half-width, or the target magnitude for RTP) so metrics on
different scales are comparable. `w_m` are weights from `TunerConfig` (default: RTP
weighted to dominate, since it is the headline promise).

**The key property:** `fitness == 0  ⟺  verify() would PASS`. The GA's optimum and
the simulator's PASS criterion are identical by construction — the tuner cannot
"succeed" at something the simulator would reject. RTP uses the same
`±rtp_tolerance` band as `verify`; volatility and hit-rates use the same
`[min, max]` bands. The fitness function is a pure function of `Metrics` + the
`TargetSpec` bands, unit-tested independently of the GA.

---

## 5. Evaluation strategy (the cost driver)

Each candidate costs a **full simulation** (math-spec §8: "evaluation-expensive;
that shapes the design"). A GA evaluates `population × generations` candidates, so
full-fidelity-per-candidate (millions of rounds each) is impractical.

**Two-tier fidelity.**

- **Search tier.** During evolution, candidates are measured at a small
  `search_candidate_count` (e.g. 10k–100k rounds) — cheap, slightly noisy fitness.
- **Final tier.** When the GA terminates, the best model is **re-measured at the
  full `final_candidate_count`** (1M+) and run through the **real `verify()`**. Only
  a model that passes the full verify is reported **PASS**. A model that wins the
  cheap search but fails the full verify is reported as **near-miss** (its measured
  metrics + which band it missed), never a false PASS.

**Common random numbers.** Within a generation, **every candidate is measured on
the same deterministically-derived seed set** (derived from `master_seed` + the
generation index). Candidates compete on identical seeds, so fitness differences
reflect the model, not seed luck — fairer selection, lower variance, and fully
reproducible. The seed set may be refreshed per generation (still deterministic) so
the search does not overfit one fixed sample.

**Termination.** The GA stops at the first of: a candidate reaching `fitness == 0`
in the search tier (then confirmed at full fidelity), `max_generations` reached, or
a stagnation window (no best-fitness improvement for *k* generations). All three
bounds come from `TunerConfig`.

---

## 6. Determinism, reproducibility & auditability

**Deterministic.** The GA's randomness (initial population, crossover points,
mutation draws, per-generation seed sets) is driven entirely by `master_seed` from
`TunerConfig`. **Same `seed_model` + `target` + `config` → identical tuned model**,
bit-for-bit, every run. This mirrors the simulator's reproducible-curation
guarantee and is a headline test (§8).

**Auditable.** The run emits two artifacts:

- **`tuned_model.json`** — the resulting `SlotModel` in the kernel's own serde
  shape (the same JSON `curate` already consumes). This is the interpretable
  artifact a human reviews and a regulator audits.
- **`tuning_report`** (human-readable text) — the search trace: per-generation best
  fitness and best metrics, the final measured metrics vs. each target band, the
  final verdict (**PASS** / **near-miss** + which band missed), and the full
  provenance (`master_seed`, GA hyperparameters, gene bounds, search vs. final
  candidate counts, seed_model identity). This proves the model was *searched
  toward a stated intent*, not hand-fixed — the "AI-designed, never AI-decided"
  evidence trail.

---

## 7. The `Tuner` seam, the GA implementation, and library choice

**The seam** (math-spec §8, "labels not machinery"):

```rust
pub trait Tuner {
    fn tune(&self, seed_model: &SlotModel, target: &TargetSpec,
            cfg: &TunerConfig) -> TuneOutcome;
}

pub struct TuneOutcome {
    pub model: SlotModel,          // best model found (interpretable)
    pub metrics: Metrics,          // its full-fidelity measured metrics
    pub verdict: Verdict,          // Pass | NearMiss { missed: Vec<BandMiss> }
    pub trace: TuningTrace,        // per-generation bests, provenance (for the report)
}
```

`GeneticTuner` is the sole implementor this slice. A future hill-climb / CMA-ES /
AI-designer is a new `impl Tuner` with no change to callers.

**Library choice (behind the seam).** Per "proven libraries behind thin seams," the
GA *implementation* will use a mature Rust GA crate — **`genevo` is the lead
candidate** (it supports custom genotypes + custom fitness, which fits our
constrained integer genome) — **if** it integrates cleanly with the
repair-after-operator requirement (§3). If the constrained/repaired genome proves
awkward to express in the library, the fallback is a **small, documented custom GA
loop** (selection / crossover / mutation / elitism). This is decided during TDD; the
`Tuner` trait and `TuneOutcome` are stable either way, so the choice never leaks to
callers. Whichever is used is recorded in the tuning report's provenance.

**Separation from freeze/sign.** The tuner stops at `TuneOutcome`. To produce a
signed package, the operator hands `tuned_model.json` to the existing
`just sim-curate <tuned_model.json> <target.json> ...`, which freezes the faithful
pool and signs — unchanged. Two crates, two responsibilities: `bloom-tuner` finds a
model that passes `verify`; `bloom-simulator` freezes + signs a passing model.

---

## 8. Testing strategy (Rust / Cargo, TDD)

Pure Rust, no Playwright surface. TDD per repo policy (`AGENTS.md`): a failing test
first, then minimal code. Run via `cargo test --workspace`.

- **Genome round-trip** — `decode(encode(model)) == model` for the tunable fields;
  fixed fields are preserved untouched.
- **Repair invariant** — an arbitrary (even adversarially out-of-bounds) genome,
  after repair + decode, is always a **valid** `SlotModel` (counts sum to strip
  length, payouts ≥ 0, `min_count` in range).
- **Fitness ⟺ verify** — `fitness == 0` exactly when `verify(metrics, target)` is
  `Ok`; fitness increases monotonically as a metric moves toward its band.
- **Reproducibility (headline)** — same `seed_model + target + config` → identical
  `tuned_model` and identical trace, across repeated runs.
- **Convergence** — a deliberately **detuned** model (e.g. the closed-form-0.9 toy
  with a wrong payout, target band around 0.9) is tuned **back into its target
  band**; the returned model passes the real `verify` at full fidelity.
- **Near-miss honesty** — a target that is unreachable within the gene bounds (or a
  cheap-search winner that fails full verify) is reported as **NearMiss** with the
  missed band(s), **never** a false PASS.
- **Common-random-numbers determinism** — candidates within a generation are scored
  on identical seed sets; the generation's seed set is a deterministic function of
  `master_seed` + generation index.
- **CLI contract** — `tune` reads the three JSON inputs, writes `tuned_model.json` +
  report, and exits non-zero on near-miss.

---

## 9. Module-level change list

**New crate `studio/tuner` (`bloom-tuner`):**

- `Cargo.toml` — deps `bloom-math`, `bloom-simulator`, an RNG (e.g. `rand` +
  `SplitMix64`/`StdRng` seeded from `master_seed`), and the chosen GA crate
  (`genevo`) *or* none if the custom loop is used. Added to the workspace
  `members`.
- `src/lib.rs` — module wiring + the `Tuner` trait, `TuneOutcome`, `Verdict`.
- `src/config.rs` — `TunerConfig` (gene bounds, GA hyperparams: population,
  `max_generations`, crossover/mutation rates, elitism; weights; `master_seed`;
  `search_candidate_count`, `final_candidate_count`; stagnation window).
- `src/genome.rs` — `encode` / `decode` / `repair` between `SlotModel` and the
  bounded-integer genome (canonical strip layout).
- `src/fitness.rs` — the weighted distance-to-band scalar over `Metrics` + bands.
- `src/genetic.rs` — `GeneticTuner: Tuner`: the evolve loop with two-tier eval +
  common random numbers + termination + trace collection.
- `src/report.rs` — render `TuningTrace` → the human-readable tuning report.
- `src/bin/tune.rs` — the CLI (mirrors `curate.rs`).

**Workspace / tooling:**

- `Cargo.toml` workspace `members` gains `studio/tuner`.
- `justfile` — a `tune` recipe:
  `just tune <seed_model.json> <target.json> <tuner_config.json> <out_model.json> <out_report.txt>`,
  plus a `tuner-build` release recipe mirroring `sim-build`.

---

## 10. Build order within this effort

1. **Genome** (`genome.rs`): encode / decode / repair — TDD (round-trip, repair
   invariant). The foundation every later step decodes through.
2. **Fitness** (`fitness.rs`): weighted distance-to-band — TDD (fitness ⟺ verify,
   monotonicity).
3. **Tuner seam + `GeneticTuner`** (`lib.rs`, `config.rs`, `genetic.rs`): the
   evolve loop with two-tier eval + common random numbers — TDD (reproducibility,
   convergence, near-miss).
4. **Report + CLI + workspace + `just`** (`report.rs`, `bin/tune.rs`): wire the
   crate into the workspace and expose the recipe.
5. **Whole-crate review** before the PR.

Each step is a fresh implementer subagent + a task review (subagent-driven
development, the repo default), with a broad whole-branch review at the end.

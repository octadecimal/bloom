# Bloom — Tuner Studio Integration (intent → tune → reconcile → apply) Design

- **Date:** 2026-06-24
- **Status:** Draft for review
- **Scope:** Bring the existing headless `bloom-tuner` genetic optimizer into the
  studio so a designer can take a game's authored `SlotModel`, **tune** it toward
  the game's design intent (the GDD), watch the search converge **live**, read an
  honest **PASS / NEAR-MISS** verdict, and — on a human's explicit click — **apply**
  the tuned model back into the one model-of-record. Today the tuner is only a CLI
  (`just tune`) over hand-written JSON files. This is the deferred UI/backend
  integration slice from the math-tuner spec §1 "Out of scope".
- **Reads first:**
  [`docs/north-star.md`](../../north-star.md) (esp. §6 "AI-designed, never
  AI-decided"),
  the math-tuner design
  [`2026-06-24-math-tuner-design.md`](2026-06-24-math-tuner-design.md)
  (the headless engine this slice wraps — §1 lists exactly what this slice picks
  up; §2 the load-bearing invariants),
  the simulator-studio integration design
  [`2026-06-24-simulator-studio-integration-design.md`](2026-06-24-simulator-studio-integration-design.md)
  (**THE PATTERN TO MIRROR** — this slice mirrors it layer-for-layer: subprocess
  `Runner` Protocol, `Hub` streaming over Socket.IO, REST endpoints, GDD-derived
  targets, a Dockview plugin pane).

---

## 1. What this delivers (and what it deliberately does not)

The tuner (`studio/tuner`, `bloom-tuner`) already does the hard search:
`GeneticTuner` mutates a `SlotModel`'s reels / paytable / bonus config until its
measured RTP / volatility / per-feature hit-rates satisfy a `TargetSpec`, scoring
each candidate through the certified simulator, and emits an interpretable tuned
model + an auditable trace. The simulator-studio integration (PR #67) already
**measures and verifies** a persisted `SlotModel` against GDD intent. This effort
wires the tuner into that same authoring plane and **closes the loop the simulator
opened** — when a model fails verification, the designer can now tune it back into
intent without hand-editing strips:

1. **Seed from the one model-of-record.** The tuner's seed is the game's existing
   `SlotModel`, read live from the simulator's **`SlotModelStore`** — no second
   model-of-record for the same game.
2. **A new tuner-only store** — a Mongo-backed `TunerStore` (`tuner_jobs`, one doc
   per game) holding only what is tuner-specific: `TuningParams` + the last
   `TuneResult` (verdict, final metrics, missed bands, per-generation trace, the
   resolved target, and the tuned model) for reload.
3. **The Rust seam** — the Python backend invokes `bloom-tuner` as a subprocess
   behind a swappable `TunerRunner` Protocol (mirroring `CurationRunner`), streaming
   **per-generation** progress over Socket.IO.
4. **Targets derived from the GDD** — the `TargetSpec` is derived from the GDD's
   structured `math-model` intent by **reusing the simulator's existing
   `targets.derive_target`** (one source of truth for the band mappings — not
   re-implemented).
5. **A studio UI** — a Dockview plugin pane to view the seed model + design intent,
   set tuning params, trigger a tune, watch the search converge live, read the
   verdict, and **apply** the tuned model back to `SlotModelStore`.
6. **Human-gated write-back** — applying the tuned model is an explicit designer
   action (`POST .../tuner/apply`); nothing is written automatically (§2.2).

**Out of scope (deferred, by decision — these are seams, not machinery):**

- **Agent / chat tools** (`tune_slot_model` via chat, read/write model tools). The
  store + runner are agent-ready, but no LangGraph tools this slice — that edits the
  hot-collision files (`ToolFactory._BUILDERS`, `RoomHub.__init__`) that an active
  chat session also touches. Agent-driven tuning is a clean follow-up once this UI
  loop is proven. (This mirrors how the simulator integration deferred its agent
  tools.)
- **Freeze / sign.** The tuner ends at a tuned, verified model. To produce a signed
  package the designer applies the model and then uses the **existing** Simulator
  pane / `just sim-curate` — single responsibility, unchanged (math-tuner §7).
- **Auto-write-back** of the tuned model into `SlotModelStore` (the human reviews
  and clicks Apply — §2.2).
- **GDD write-back** of measured actuals into the GDD doc.
- **Structured-form authoring of the model** — the seed comes from the simulator's
  existing authoring surface; this pane shows it read-only.
- **Gene-bounds / weights as a hand-edited form** — bounds are derived; weights live
  under "advanced" but bounds are not user-edited (§5, §6).
- **Other tuner strategies** (hill-climb / CMA-ES / AI math-designer) and
  **mechanics other than slots** — the engine seams make each additive; none ship
  here.

---

## 2. The anchoring decisions

### 2.1 The seed is the existing `SlotModel`; the loop is one model-of-record

The simulator integration already persists exactly one executable `SlotModel` per
game (`SlotModelStore`, collection `slot_models`), authored in the Simulator pane
and curated / frozen / signed there. The tuner does **not** introduce a second copy
of that model. It reads the current persisted `SlotModel` as its **seed**, searches
for a better one, and — on the designer's explicit Apply — writes the result **back
into the same `SlotModelStore`**. The full loop becomes:

```
author SlotModel (Simulator pane) ─▶ tune toward GDD intent (Tuner pane, THIS SLICE)
        ▲                                              │
        │ Apply (human-gated write-back)               │ live per-gen progress
        └──────────────────────────────────────────────┘
                         ▼
        curate → verify → freeze → sign (Simulator pane / just sim-curate)
```

The tuner's own store (`tuner_jobs`) holds only tuner-specific state
(`TuningParams` + last `TuneResult`); the `SlotModel` itself stays owned by
`SlotModelStore`. This keeps a single source of truth for the executable model and
makes the author → tune → curate → sign hand-off seamless.

### 2.2 AI-designed, never AI-decided — Apply is explicit

The tuner lives entirely in the authoring plane and its output is an
**interpretable `SlotModel`** (the same human-readable strips/paytable a designer
would author by hand). A regulator audits the final strips, not the search
(north-star §6, math-tuner §2.2). Critically, the tuned model is **never written
back automatically**: the designer reviews the verdict + measured-vs-intended
metrics, then explicitly clicks **Apply tuned model** (`POST .../tuner/apply`) to
make it the model-of-record. The GA helps a human design a game; the human decides
whether to keep its proposal.

### 2.3 The engine is the optimizer; the studio is a thin shell

All search + measurement logic stays in the certified core. The studio adds **no**
new tuning logic. The backend assembles a `TunerConfig` from `TuningParams` + the
GDD-derived `TargetSpec` + derived gene bounds, shells out to the tuner, and streams
its trace. The tuner's load-bearing invariant — **it optimizes model parameters,
never seed selection** — is structurally enforced inside the crate (math-tuner §2.1)
and this slice does nothing that could break it: the studio passes a fixed
`master_seed` through the config and never feeds the tuner a seed _pool_ to choose
from.

### 2.4 GDD intent has one mapping, shared with the simulator

The GDD `math-model` → `TargetSpec` derivation is **identical** to what the
simulator already does. We **reuse `app.simulator.targets.derive_target`** rather
than duplicate it — one unit-tested source of truth for the enum→band / ratio→band
mappings. (Consequence: the tuner backend package imports from the simulator
package. This is a read-only dependency; if the simulator session refactors
`targets.py`, coordinate. See §9.)

---

## 3. The data model

### 3.1 The executable model (unchanged — owned by the simulator)

`bloom_math::mechanics::slots::SlotModel`, persisted by the simulator's
`SlotModelStore` in the `slot_models` collection, is the authoritative schema and
the model-of-record. The tuner reads it (seed) and, on Apply, writes it back. **We
do not redefine it.**

### 3.2 The persisted tuner document (new)

One document per game in a new `tuner_jobs` collection (`TunerStore`, mirroring
`SlotModelStore`):

```python
class TunerJobDoc(_WireModel):
    id: str
    game_id: str
    params: TuningParams
    result: TuneResult | None   # last run (pass / near_miss / error), for reload
    created_at: datetime
    updated_at: datetime

class TuningParams(_WireModel):
    # minimal (always shown)
    master_seed: int
    population: int
    max_generations: int
    search_candidate_count: int   # rounds per candidate during search (cheap)
    final_candidate_count: int    # rounds for the final winner (full fidelity)
    # advanced (collapsible)
    elitism: int
    mutation_rate: float          # [0, 1]
    crossover_rate: float         # [0, 1]
    stagnation_window: int
    weights: TuneWeights          # per-metric fitness weights (rtp dominates by default)

class TuneResult(_WireModel):
    status: Literal["pass", "near_miss", "error"]
    verdict: Literal["pass", "near_miss"] | None
    tuned_model: dict | None      # the tuned SlotModel serde shape (what Apply writes)
    metrics: MetricsWire | None   # final full-fidelity measured metrics
    missed: list[BandMiss]        # bands missed on near_miss (empty on pass)
    trace: list[GenSnapshotWire]  # per-generation best fitness/rtp/volatility, for the chart + reload
    target: TargetSpecWire | None # the resolved TargetSpec (provenance / display)
    failure: str | None           # subprocess error / stderr, human-readable
    ran_at: datetime
```

`params` holds only the tuner knobs the GDD does **not** express. Gene **bounds**
are _not_ in `params` — they are derived from the seed model at run time (§4.3).
`result.tuned_model` is the canonical kernel serde shape so Apply can hand it
straight to `SlotModelStore`.

### 3.3 Deriving `TargetSpec` from GDD intent (reused)

`derive_target(math_model, params, num_bonuses) -> TargetSpec` from
`app.simulator.targets` is reused verbatim (§2.4). The tuner needs the same target
characteristics (RTP target, volatility band, per-bonus hit-rate bands) the
simulator verifies against — by construction, the tuner's `fitness == 0` is the same
condition as the simulator's `verify() == PASS` (math-tuner §4), so they **must**
share one target derivation.

---

## 4. The Rust seam: invoking the tuner

### 4.1 Mechanism — subprocess, not PyO3

The backend invokes `bloom-tuner` as a **subprocess** behind a `TunerRunner`
Protocol, identical in shape to `CurationRunner`. Same rationale as the simulator
(simulator §4.1): subprocess keeps the trusted Rust boundary clean, isolates the
CPU-heavy job, and is trivially fakeable. Tuning is a batch job, so process overhead
is irrelevant.

```python
class TunerRunner(Protocol):
    async def run(self, seed_model: dict, target: dict, config: dict,
                  on_progress: Callable[[TuneProgress], None]) -> TuneResult: ...
```

- **`SubprocessTunerRunner`** — writes `seed_model.json` + `target.json` +
  `tuner_config.json` to a temp dir, spawns the Rust JSON binary, reads its stdout
  stream line-by-line, calls `on_progress` per progress line, resolves with the
  final result line. Invokes a prebuilt release binary by path (from settings);
  `cargo run --release -p bloom-tuner --bin tune_json --` as a dev fallback (mirrors
  `SubprocessCurationRunner`).
- **`FakeTunerRunner`** — deterministic in-memory impl for unit tests (no
  subprocess), emits a scripted per-generation progress sequence + a fixed result.

`TuneProgress(generation, max_generations, best_fitness, best_rtp, best_volatility)`.

### 4.2 The Rust addition — a streaming JSON entrypoint

The existing `tune` CLI runs the whole GA and writes `tuned_model.json` + a text
report at the end — no progress stream. We add an **additive sibling binary**
(`studio/tuner/src/bin/tune_json.rs`, mirroring `curate_json.rs`) — leaving the
existing `tune` arg contract **byte-for-byte untouched** — that:

- reads `seed_model` + `target` + `tuner_config` (JSON, from files or stdin),
- runs the GA via a new `tune_with_progress` wrapper,
- emits newline-delimited JSON to **stdout**:
  - one `{"type":"progress","generation":N,"maxGenerations":M,"bestFitness":f,
"bestRtp":r,"bestVolatility":v}` line **per generation** (forwarded from the
    GA's per-generation snapshot, which it already builds),
  - a final `{"type":"result","verdict":"pass"|"near_miss","model":{...},
"metrics":{...},"missed":[...],"trace":[...]}` line.
- **Exit 0 always** (the verdict is in the JSON, like `curate_json`); non-zero only
  on bad args / unparseable input (exit 2).

The new wrapper:

```rust
pub fn tune_with_progress(
    seed_model: &SlotModel, target: &TargetSpec, cfg: &TunerConfig,
    on_progress: impl FnMut(&GenSnapshot),
) -> TuneOutcome
```

threads an `FnMut(&GenSnapshot)` callback through the evolve loop, invoked once per
generation as each snapshot is produced. The existing `GeneticTuner::tune` (and the
`Tuner` trait, and the `tune` CLI) call it with a **no-op callback** and stay
behavior-identical and bit-reproducible. This mirrors exactly how the simulator
added `run_curation_with_progress` without changing `run_curation`. Progress is
**cosmetic** — it never affects the deterministic result.

### 4.3 Gene bounds — derived from the seed model

`TunerConfig` requires `GeneBounds` (and `validate` checks them), so _something_ must
supply bounds. We **derive sensible default bounds from the seed model** (per-symbol
count ranges over the seed's fixed strip length, payout ranges from the seed's
paytable magnitudes, bonus-config ranges from the seed's bonuses) via a **pure,
unit-tested** function. Home of that function (a Rust helper in the crate vs. a
Python pure function in the backend) is a small plan-time decision; the default is
**backend-side** (`tuner/bounds.py`), to keep the engine crate read-only beyond the
additive streaming binary. Either way it is deterministic and unit-tested.

### 4.4 Backend orchestration — `TunerHub` + Socket.IO

Mirrors `CurationHub`:

- **`POST /games/:id/tuner/tune`** kicks off a run (returns 202 accepted).
- **`TunerHub`** loads the seed `SlotModel` from `SlotModelStore`, the `TuningParams`
  from `TunerStore`, derives the `TargetSpec` from the GDD (reused `derive_target`),
  derives gene bounds (§4.3), assembles the `TunerConfig`, invokes the
  `TunerRunner`, emits **`tuning_progress`** per generation, and on completion emits
  **`tuning_complete`** (with the `TuneResult`) or **`tuning_failed`**, persisting
  the result to `TunerStore`.
- The frontend subscribes to those events on the active game (exactly as the
  simulator pane subscribes to curation progress).

---

## 5. REST + Socket surface

REST (camelCase wire via the existing alias generator), all game-scoped:

- `GET  /games/:id/tuner` → `TunerJobDoc` (seeds default params if none).
- `PUT  /games/:id/tuner` → upsert `params` (validated; helpful error, no partial
  write).
- `GET  /games/:id/tuner/seed` → the current seed `SlotModel` from `SlotModelStore`
  (so the UI shows what will be tuned; 404-equivalent "no model yet" state if none).
- `GET  /games/:id/tuner/target` → the `TargetSpec` derived from current GDD intent
  (so the UI shows design intent before tuning, and flags gaps).
- `POST /games/:id/tuner/tune` → kick off a tune (progress via socket; 202).
- `POST /games/:id/tuner/apply` → write `result.tuned_model` into `SlotModelStore`
  (human-gated write-back). Returns the updated `SlotModelDoc`. Errors if there is
  no applicable tuned model.
- `GET  /games/:id/tuner/result` → last persisted `TuneResult` (reload).

Socket events (game room): `tuning_progress`, `tuning_complete`, `tuning_failed`;
join/leave via `join_tuner` / `leave_tuner`.

---

## 6. Frontend (`studio/frontend/src/plugins/tuner/`)

A new `IPlugin<ITunerState>` registered like the simulator/GDD/assets plugins
(`plugins/index.ts`), with one Dockview pane mirroring `plugins/simulator/`:

- **`config.ts`** — re-export `BACKEND_URL` (as the simulator plugin does).
- **`restClient.ts`** — fetch helpers for the endpoints above (incl. `apply`).
- **`socketClient.ts`** — subscribe to `tuning_progress` / `_complete` / `_failed`
  for the active game.
- **`state.ts`** — Hookstate slice: `seedModel`, `params`, `derivedTarget`,
  `progress` (latest per-gen snapshot + accumulated trace), `result`, `status`
  (`idle|running|pass|near_miss|error`).
- **`TunerPane.tsx`**:
  - a read-only **"Seed model"** panel (current `SlotModel`; the tune input) and a
    read-only **"Design intent (from GDD)"** panel showing `derivedTarget` (and any
    gap, e.g. bonus-count mismatch or missing intent);
  - a **`TuningParams` form**: minimal fields always visible (`master_seed`,
    `population`, `max_generations`, `search_candidate_count`,
    `final_candidate_count`) + a collapsible **advanced** group (`elitism`,
    `mutation_rate`, `crossover_rate`, `stagnation_window`, `weights`);
  - a **Tune** button → a **live convergence view** driven by `tuning_progress`
    (generation N / M, best fitness, best RTP trending toward the band);
  - a **results panel**: a prominent **PASS / NEAR-MISS** badge, measured-vs-intended
    per metric (RTP, volatility, per-feature hit-rate), and the **missed bands**
    listed on near-miss;
  - an **Apply tuned model** button (enabled when a tuned model exists; primary on
    PASS, with a "still missing X band" warning on near-miss) → `POST .../apply` →
    success toast ("applied — open the Simulator to curate & sign").

Strict design-language adherence (4 surfaces / 2 hairlines / 3 text tiers / 1
accent; `--success` for PASS, `--danger`/`--warning` for near-miss; no raw hex — the
guard test enforces it).

---

## 7. Error handling

- **NEAR-MISS is a first-class informative state**, never a thrown error: the UI
  names which metric missed which GDD-intended band (e.g. "RTP measured 0.91, intent
  0.96 ± 0.01") and still offers Apply (with a warning), because a designer may want
  to keep a close-but-imperfect model and iterate.
- **No seed model yet** → the seed panel shows an empty state and Tune is blocked
  with "author a model in the Simulator first".
- **Missing GDD intent** (required `math-model` fields empty) → the target panel
  shows the gap (reusing the simulator's gap detection) and Tune is blocked with a
  clear "fill RTP / volatility / bonus rate in the GDD first" message.
- **Invalid `params`** (e.g. `population` ≤ 0, `final < search` where required) →
  validated **before** invoking the runner; inline error, no run.
- **Subprocess crash / non-zero exit** → `status: "error"` with stderr surfaced.
- **Apply with no applicable tuned model** → 4xx with a clear message; the button is
  disabled in that state anyway.

---

## 8. Testing strategy

A gift inherited from the engine: tuning is **deterministic and offline** — unlike
LLM/ComfyUI it needs **no replay cassettes**. e2e runs _real_ tunes at tiny
candidate counts (math-tuner §8, simulator §8).

**Rust (cargo, TDD):**

- `tune_with_progress` invokes the callback **once per generation** and returns a
  `TuneOutcome` **bit-identical** to `GeneticTuner::tune` for the same inputs (no
  behavior drift; the no-callback path is unchanged).
- `tune_json` emits well-formed per-generation `progress` lines + a final `result`
  line; the result matches the library outcome; exit code contract (0 on
  pass/near_miss, 2 on bad input).

**Backend (pytest, CI-affordable):**

- `TunerStore`: upsert leaves untouched fields, persists result, seeds defaults.
- Gene-bounds derivation (`bounds.py`): pure, deterministic, sane vs. a seed model.
- `TunerRunner` via `FakeTunerRunner`: per-gen progress + result plumbing, and
  pass / near_miss / error mapping.
- REST: `apply` writes `result.tuned_model` into `SlotModelStore` (read back to
  confirm); `tune` returns 202 and fires the hub; `target`/`seed` reflect the
  current GDD + slot model; param validation rejects bad input.
- `TunerHub` emit sequence (progress\* → complete | failed) and result persistence.
- One **integration test** that shells out to the real `tune_json` binary with a
  tiny `population` / `search_candidate_count` / `final_candidate_count`
  (deterministic, offline) — proves the subprocess contract end-to-end.
- (We do **not** re-test `derive_target` here — it is the simulator's, already
  tested; we add one test asserting the tuner backend imports and uses it.)

**Frontend:**

- Vitest: `restClient`, target/seed/result display, params form (incl. advanced
  toggle), state transitions across the live-progress lifecycle.
- **Playwright e2e (authoritative):** seed a deliberately **detuned** model (via the
  simulator's `PUT slot-model`) with a GDD intent it misses → set tiny tuning params
  → **Tune** → watch progress → assert **PASS** + measured RTP within the intended
  band → click **Apply** → confirm `SlotModelStore` now holds the tuned model
  (e.g. the seed panel / a re-fetch shows it, or a follow-on curate passes). A
  second path: a target unreachable within derived bounds → assert an honest
  **NEAR-MISS** with the missed band shown. Real tunes, tiny counts, no cassettes;
  run locally (`just e2e`), not in CI (repo policy).

---

## 9. Module-level change list

**Rust** (`studio/tuner`):

- new streaming JSON binary (`src/bin/tune_json.rs`) + a `tune_with_progress`
  wrapper (in `genetic.rs` or `lib.rs`) threading an `FnMut(&GenSnapshot)` callback
  through the evolve loop. The existing `tune` CLI, the `Tuner` trait, and
  `GeneticTuner::tune` are untouched. `GenSnapshotWire`-shaped JSON in the protocol.
- `justfile`: `tuner-build` (already exists) builds `tune_json` too; the runner's
  dev fallback uses `cargo run --release -p bloom-tuner --bin tune_json`.

**Backend** (`studio/backend/app/tuner/`, new package):

- `models.py` (`TunerJobDoc`, `TuningParams`, `TuneWeights`, `TuneResult`,
  `BandMiss`, `GenSnapshotWire`, `TuneProgress` wire models),
  `store.py` (`TunerStore`),
  `bounds.py` (seed model → default `GeneBounds`, pure),
  `runner.py` (`TunerRunner` Protocol + `SubprocessTunerRunner` + `FakeTunerRunner`),
  `hub.py` (`TunerHub`, reusing `app.simulator.targets.derive_target` and
  `SlotModelStore`),
  `rest.py` (routers, incl. `apply`),
  `sockets.py` (`register_tuner_handlers`).
- Wire into `app/main.py` `build()` (~5 lines mirroring `sim_`): instantiate
  `TunerStore`, build `TunerHub(sio, tuner_store, slot_model_store, build_tuner_runner(settings), gdd_store)`,
  attach to `app.state`, `register_tuner_handlers`, include the router. New Mongo
  collection `tuner_jobs`. **No** edits to `ToolFactory._BUILDERS` /
  `RoomHub.__init__` (agent tools deferred — §1).

**Frontend** (`studio/frontend/src/plugins/tuner/`, new plugin):

- `index.ts`, `state.ts`, `config.ts`, `restClient.ts`, `socketClient.ts`,
  `TunerPane.tsx`; register in `plugins/index.ts`. e2e: `e2e/tuner.spec.ts`.

---

## 10. Build order within this effort

1. **Rust `tune_with_progress` + `tune_json`** (+ recipe coverage) — TDD; the
   subprocess streaming contract everything else depends on. Prove no behavior drift
   vs. `GeneticTuner::tune`.
2. **Backend `TunerStore` + `bounds.py`** — pure, unit-first.
3. **Backend runner seam** (`TunerRunner` Protocol + `SubprocessTunerRunner` +
   `FakeTunerRunner`) — with the integration test that shells out to real `tune_json`
   at tiny counts.
4. **Backend hub + REST + sockets** (`TunerHub`, routers incl. `apply`, handlers) —
   wire into `build()`, reusing `simulator.targets` + `SlotModelStore`.
5. **Frontend plugin** (seed/intent panels, params form, live convergence, verdict,
   apply).
6. **e2e** (`tuner.spec.ts`) — real tune; PASS + apply path and near-miss path.

Each step is a fresh implementer subagent + a task review (subagent-driven
development, the repo default), with a broad whole-branch review at the end.

**Dependencies:** the simulator-studio integration (PR #67) and the structured GDD
are both already merged to `main`, so there is no unmerged-branch blocker. This slice
touches the studio collision zone (`main.py build()`, `plugins/index.ts`) and
read-only-imports the simulator package — rebase `main` often and coordinate with an
active simulator/frontend session if `targets.py` / `SlotModelStore` move (§2.4).

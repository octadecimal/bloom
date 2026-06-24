# Bloom — Simulator Studio Integration (author → curate → reconcile) Design

- **Date:** 2026-06-24
- **Status:** Draft for review
- **Scope:** Bring the existing `bloom-simulator` curation engine into the studio so
  a designer can author an executable slot model, run a real curation, and see
  measured **RTP / volatility / per-feature hit-rates** reconciled against the
  game's **design intent** (the GDD) — live in the UI. Today the simulator is only
  a CLI (`just sim-curate`) over hand-written JSON files.
- **Reads first:**
  [`docs/north-star.md`](../../north-star.md),
  the math-engine + simulator design
  [`2026-06-23-math-engine-simulator-design.md`](2026-06-23-math-engine-simulator-design.md)
  (esp. §2 Approach A, §5 the pipeline, §8 the deferred tuner),
  the GDD structured-content design
  [`2026-06-24-gdd-structured-content-design.md`](2026-06-24-gdd-structured-content-design.md)
  (esp. §4 the data model, §11 future work — this effort is its "math
  reconciliation engine").

---

## 1. What this delivers (and what it deliberately does not)

The simulator (`studio/simulator`) already does the hard math: `run_curation`
measures a `SlotModel`, **verifies** it against a `TargetSpec`, **freezes** a
faithful signed seed pool, or **fails loudly** (Approach A — the model defines the
characteristics; curation never reshapes to hit a target). This effort wires that
engine into the authoring plane:

1. **A persisted executable model per game** — a Mongo-backed `SlotModelStore`
   holding the `SlotModel` (the executable realization) + curation parameters +
   the last curation result. The studio's single durable, agent-ready artifact for
   slot math.
2. **The Rust seam** — the Python backend invokes `bloom-simulator` as a
   subprocess behind a swappable `CurationRunner` protocol (mirrors how
   `ComfyProvider` wraps external compute), streaming progress over Socket.IO.
3. **Targets derived from the GDD** — the `TargetSpec`'s target _characteristics_
   (RTP, volatility band, bonus hit-rate band) are derived from the GDD's
   structured `math-model` intent, not re-typed. The GDD stays the single source of
   truth for _what the game should be_.
4. **A studio UI** — a Dockview plugin pane to author the model (JSON for now),
   trigger a curation, watch progress, and read the verdict: measured-vs-intended
   per metric, realized RTP, pool size, and a prominent **PASS/FAIL**.

**Out of scope (deferred, by decision — these are seams, not machinery):**

- **Layer-3 tuning (intent → strips).** Automatically deriving/adjusting the
  executable strips to _hit_ the GDD intent (math-spec §8). A human edits the model
  and re-curates; the auto-tuner / AI math-designer comes later.
- **Agent tools** (`read_slot_model` / `write_slot_model` / `curate` via chat). The
  store is designed agent-ready, but no LangGraph tools this slice (the agent's
  compelling job here is the deferred tuner).
- **GDD write-back** of measured actuals into the GDD doc.
- **Structured form authoring** — a JSON editor over the persisted document for
  now; field-by-field forms later.
- **Package-management UI.** Curation still produces a signed package; we store /
  offer it but build no package browser.
- **Mechanics other than slots**, and richer slot features beyond what
  `slots@1` already evaluates.

---

## 2. The anchoring decision: intent vs. realization, reconciled

The GDD (structured-content effort) already holds a paytable, symbols, reel
strips, RTP, volatility, bonus hit-rate. The executable kernel `SlotModel` _also_
holds a paytable, symbols, reels, bonuses. Authored independently, that is **two
sources of truth for the same paytable** — the exact thing we must avoid.

We resolve it by recognising these are **two layers, not two copies**:

- **GDD structured data = the single source of truth for design _intent_.**
  Human-level: "96% RTP, high volatility, a 1:200 bonus, these symbols, this
  paytable shape." The one place the designer (and later the AI) says _what the
  game should be_.
- **Executable `SlotModel` = the _realization_.** The actual strips / paylines /
  paytable that, when simulated, are _supposed to_ produce that intent. A
  downstream artifact, not a competing source of intent.
- **The simulator = the _reconciliation_.** It measures the realization and
  verifies it against the GDD intent. **PASS** = "your strips genuinely produce
  your stated design." **FAIL** = "you said 96% but these strips measure 91%."
  This is precisely the "math reconciliation engine" the GDD spec §11 defers to us.

The GDD deliberately makes mathematical _correctness_ a non-goal (its §2): it
guarantees a _filled_ paytable and a _stated_ RTP, not that the strips _produce_
that RTP, and it holds intent loosely (`volatility` is an enum, `paylines` is
text, `reel_strips.composition` is prose). So the GDD **cannot be auto-compiled**
into a faithful executable model without the deferred tuner — which is exactly why
the realization is authored, not derived, this slice.

```
GDD structured intent/targets  ──[layer-3 tuner, deferred §8]──▶  SlotModel (realization)
   (single SoT, next door)                                              │
        │ targets.py derives TargetSpec characteristics                 │ authored here (JSON)
        ▼                                                               ▼
                         simulator: measure → verify(vs intent) → freeze → sign   ◀── THIS SLICE
```

### 2.1 Merge-order dependency

We read the GDD's structured `data` and its schema, which live on the unmerged
`feat/gdd-structured-content` branch. **That PR must merge to `main` before ours**
(or we rebase onto it). The implementation plan assumes the structured GDD has
landed; until then the GDD-intake module is the one piece that cannot be finished.

---

## 3. The data model

### 3.1 The executable model (unchanged — owned by the kernel)

`bloom_math::mechanics::slots::SlotModel` is the authoritative schema
(`symbols`, `reels`, `rows`, `paylines`, `paytable`, `bonuses`), serialized to
JSON via serde for authoring and to the package `math_payload` via postcard. **We
do not redefine it** — the studio round-trips the kernel's own serde shape.

### 3.2 The persisted studio document (new)

One document per game in a new `slot_models` collection
(`SlotModelStore`, mirroring `GddStore` / `AssetStore`):

```python
class SlotModelDoc(_WireModel):
    id: str
    game_id: str
    model: dict            # CANONICAL realization — the kernel SlotModel serde shape
    params: CurationParams # curation-only knobs (NOT in the GDD)
    result: CurationResult | None  # last run (PASS or FAIL), for reload
    created_at: datetime
    updated_at: datetime

class CurationParams(_WireModel):
    pool_size: int
    candidate_count: int
    master_seed: int
    rtp_tolerance: float
    realized_correction_band: float

class CurationResult(_WireModel):
    status: Literal["pass", "fail", "error"]
    metrics: Metrics            # rtp, volatility, hit_frequency, bonus_hit_rates[], base_rtp, feature_rtp
    realized_rtp: float | None  # present on pass (the frozen pool's realized RTP)
    target: TargetSpecWire      # the TargetSpec actually used (derived from GDD intent + params)
    failure: str | None         # which band(s) missed, or the curate error, human-readable
    pool_size: int | None
    ran_at: datetime
```

`params` holds only the knobs the GDD does **not** express (pool/candidate counts,
master seed, tolerances). The target _characteristics_ come from the GDD (§3.3),
so they are never duplicated in our store; `result.target` records the resolved
`TargetSpec` for provenance/display.

### 3.3 Deriving `TargetSpec` from GDD intent (`targets.py`)

A pure module maps the GDD `math-model` structured fields to the simulator's
`TargetSpec` characteristics:

| GDD `math-model` field        | → `TargetSpec`                              | Mapping                                                       |
| ----------------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| `rtp` (percent)               | `rtp_target`                                | `0.96` direct                                                |
| `volatility` (enum)           | `volatility_min` / `volatility_max`         | defined enum→numeric-band table (low/medium/medium-high/high) |
| `bonus_hit_rate` (ratio)      | one `HitRateBand` per model bonus           | `1:200` → center `0.005` ± tolerance band                     |
| `hit_frequency` (percent)     | (informational; reported vs measured)       | not a hard band in slice 1                                    |
| `params.*` (our store)        | `pool_size`, `candidate_count`, tolerances, `realized_correction_band` | from `CurationParams`              |

The enum→band and ratio→band mappings are **defined, unit-tested pure functions**.
Band widths come from `params` / sensible defaults. The number of
`bonus_hit_rate_bands` must equal `model.bonuses.len()` (the simulator asserts
this); the intake produces one band per model bonus, defaulting from the GDD's
single `bonus_hit_rate` when the model has one bonus, and surfacing a clear gap if
counts disagree.

---

## 4. The Rust seam: invoking the simulator

### 4.1 Mechanism — subprocess, not PyO3

The backend invokes `bloom-simulator` as a **subprocess** behind a
`CurationRunner` protocol. Rejected PyO3 because it forces maturin into the Python
build + CI, platform wheels, and a hard compile coupling; subprocess keeps the
trusted Rust boundary clean, isolates the CPU job, and is trivially fakeable.
Curation is a batch job (seconds), so process overhead is irrelevant. This mirrors
the existing pattern where external compute (ComfyUI) sits behind a `Provider`
protocol.

```python
class CurationRunner(Protocol):
    async def run(self, model: dict, target: TargetSpec,
                  on_progress: Callable[[CurationProgress], None]) -> CurationResult: ...
```

- **`SubprocessCurationRunner`** — writes the model + target to a temp dir, spawns
  the Rust JSON binary, reads its stdout stream line-by-line, calls `on_progress`
  per progress line, resolves with the final result line. Invokes a prebuilt
  release binary by path; `cargo run -p bloom-simulator` as a dev fallback.
- **`FakeCurationRunner`** — deterministic in-memory impl for unit tests (no
  subprocess), emits a scripted progress sequence + a fixed result.

### 4.2 The Rust addition — a streaming JSON entrypoint

The existing `curate` CLI emits a human text report + the signed `.pkg`. We add an
**additive sibling binary** (`src/bin/curate_json.rs`) — leaving the existing
`curate` arg contract untouched — that:

- reads `model` + `target` (JSON, from files or stdin),
- runs the existing `run_curation` pipeline (the certified `bloom-package` format
  is **untouched**),
- emits newline-delimited JSON to **stdout**:
  - `{"type":"progress","phase":"simulate","done":N,"total":M}` during the run —
    phase transitions (generate / simulate / measure / verify / freeze / sign) plus
    **sub-progress during `simulate`** (the dominant step) via a sampled
    `AtomicUsize` counter incremented inside the rayon `par_iter`, throttled;
  - a final `{"type":"result", status, metrics, realized_rtp, ...}` line.

Progress is **cosmetic** — sampling an atomic counter never affects output order or
the bit-reproducible result. The pure `run_curation` stays as-is; a
`run_curation_with_progress(..., on_progress)` wrapper threads the callback so the
binary can report, and the no-callback path keeps existing tests/CLI unchanged.

### 4.3 Backend orchestration — `CurationHub` + Socket.IO

Mirrors the asset pipeline (`AssetHub` yielding progress then the image):

- **`POST /games/:id/slot-model/curate`** kicks off a run (returns accepted).
- **`CurationHub`** loads the stored model + derives the `TargetSpec` from the GDD,
  invokes the `CurationRunner`, and on each `on_progress` emits
  **`curation_progress`** to the game room; on completion emits
  **`curation_complete`** (with the `CurationResult`) or **`curation_failed`**, and
  persists the result to the store.
- The frontend subscribes to those events on the active game, exactly as the asset
  board subscribes to generation progress.

---

## 5. REST + Socket surface

REST (camelCase wire via the existing alias generator), all game-scoped:

- `GET  /games/:id/slot-model` → `SlotModelDoc` (seeds an empty model + default
  params if none exists).
- `PUT  /games/:id/slot-model` → upsert `model` + `params` (validated against the
  kernel serde shape; invalid JSON returns a helpful error, no partial write).
- `GET  /games/:id/slot-model/target` → the `TargetSpec` derived from current GDD
  intent (so the UI can show "design intent" before curating, and flag gaps).
- `POST /games/:id/slot-model/curate` → kick off a curation (progress via socket).
- `GET  /games/:id/slot-model/result` → last persisted `CurationResult` (reload).

Socket events (game room): `curation_progress`, `curation_complete`,
`curation_failed`.

---

## 6. Frontend (`studio/frontend/src/plugins/simulator/`)

A new `IPlugin<ISimulatorState>` registered like the GDD/assets plugins, with one
Dockview pane:

- **`restClient.ts`** — fetch helpers for the endpoints above.
- **`socketClient.ts`** — subscribe to `curation_progress` / `_complete` /
  `_failed` for the active game.
- **`state.ts`** — Hookstate slice: `model` (JSON text), `params`,
  `derivedTarget`, `progress`, `result`, `status` (`idle|running|pass|fail|error`).
- **`SimulatorPane.tsx`**:
  - a **JSON editor** for the executable model + a small `params` form;
  - a read-only **"Design intent (from GDD)"** panel showing `derivedTarget`
    (and any gap, e.g. bonus-count mismatch);
  - a **Curate** button → progress bar driven by `curation_progress`;
  - a **results panel**: measured-vs-intended per metric (RTP, volatility,
    per-feature hit-rate), realized RTP, pool size, and a prominent **PASS / FAIL**
    badge.

Strict design-language adherence (4 surfaces / 2 hairlines / 3 text tiers / 1
accent; `--success` / `--danger` for the verdict; no raw hex — the guard test
enforces it).

---

## 7. Error handling (Approach A = fail loud)

FAIL is a **first-class, informative state**, never a thrown error:

- `RunError::VerifyFailed(metrics)` → `status: "fail"`; the UI names which metric
  missed which GDD-intended band (e.g. "RTP measured 0.91, intent 0.96 ± 0.01").
- `CurateError::OutsideCorrectionBand` → `status: "fail"` with the honesty-guardrail
  message: "realized RTP would move further than allowed — retune the model, this
  is not a curation problem" (math-spec §2.1).
- Invalid / malformed model JSON, or a `bonus_hit_rate_bands` ↔ `model.bonuses`
  count mismatch → validated **before** invoking the runner; inline error.
- Subprocess crash / non-zero exit → `status: "error"` with stderr surfaced.
- Missing GDD intent (required `math-model` fields empty) → the target panel shows
  the gap and Curate is blocked with a clear "fill RTP / volatility / bonus rate in
  the GDD first" message.

---

## 8. Testing strategy

A gift of this feature: the simulator is **deterministic and offline** — unlike
LLM/ComfyUI it needs **no replay cassettes**. e2e runs _real_ curations at small
scale.

**Rust (cargo, TDD):**

- The new JSON/streaming entrypoint: emits well-formed progress lines + a final
  result line; result matches the library `run_curation` (no behavior drift); the
  no-callback path leaves existing output unchanged.

**Backend (pytest, CI-affordable):**

- `targets.py`: volatility enum→band, ratio→band, percent parsing, bonus-count
  matching, missing-intent gap detection.
- `SlotModelStore`: upsert leaves untouched fields, persists result.
- `CurationRunner` via `FakeCurationRunner`: progress + result plumbing,
  PASS/FAIL/error mapping.
- One **integration test** that shells out to the real binary with a tiny
  `candidate_count` (deterministic, offline) — proves the subprocess contract.
- REST endpoints + the `CurationHub` emit sequence (progress → complete/failed).

**Frontend:**

- Vitest: `restClient`, `targets` display, state transitions.
- **Playwright e2e (authoritative):** author a model → Curate → watch progress →
  assert **PASS**; and a second model whose strips miss the GDD intent → assert
  **FAIL** with the missed-metric detail. Real curation, small `candidate_count`,
  no cassettes. Per repo policy, run locally (`just e2e`), not in CI.

---

## 9. Module-level change list

**Rust** (`studio/simulator`):

- new streaming JSON binary (`src/bin/curate_json.rs`) + a
  `run_curation_with_progress` wrapper in `run.rs`; `measure::simulate`
  gains an optional sampled progress counter. `just` recipe to build the release
  binary.

**Backend** (`studio/backend/app/simulator/`, new package):

- `models.py` (`SlotModelDoc`, `CurationParams`, `CurationResult`, wire models),
  `store.py` (`SlotModelStore`), `targets.py` (GDD intent → `TargetSpec`),
  `runner.py` (`CurationRunner` protocol + `SubprocessCurationRunner` +
  `FakeCurationRunner`), `hub.py` (`CurationHub`), `rest.py` (routers),
  `sockets.py` (event handlers). Wire into `app/main.py` `build()` and the DI
  `AppContext`. New Mongo collection `slot_models`.

**Frontend** (`studio/frontend/src/plugins/simulator/`, new plugin):

- `index.ts`, `state.ts`, `restClient.ts`, `socketClient.ts`, `SimulatorPane.tsx`;
  register in `setupApp.ts`. e2e: `e2e/simulator.spec.ts`.

---

## 10. Build order within this effort

1. **Rust streaming JSON entrypoint** (+ progress wrapper + recipe) — TDD, the
   subprocess contract everything else depends on.
2. **Backend `targets.py`** (GDD intent → `TargetSpec`) — pure, unit-first.
3. **Backend store + runner seam** (`SlotModelStore`, `CurationRunner` +
   subprocess impl + fake) — with the integration test that shells out for real.
4. **Backend hub + REST + sockets** (`CurationHub`, routers, handlers) — wire into
   `build()`.
5. **Frontend plugin** (pane, state, rest/socket clients) — author + curate +
   progress + results.
6. **e2e** (`simulator.spec.ts`) — real curation, PASS + FAIL paths.

Step 2 (and the GDD-intake wiring in step 4) assume `feat/gdd-structured-content`
has merged (§2.1).

# Chat-Driven Math Tuning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four LangGraph chat tools (`read_tuner_setup`, `set_tuner_params`, `tune_slot_model`, `apply_tuned_model`) plus a `tune-math` skill so a designer can read the tuner setup, adjust GA knobs, run a real tune, and human-gated apply the result — all from chat.

**Architecture:** Thin chat adapters over the already-merged tuner backend (`TunerHub` / `TunerStore` / `SlotModelStore`). `tune_slot_model` awaits `TunerHub.request_tune` (which runs the GA to completion and streams progress to the Tuner pane) then reads the persisted `TuneResult`. `apply_tuned_model` writes the tuned model back via `SlotModelStore.put` behind a LangGraph `interrupt()` approval. Wiring threads three new dependencies (`sim_store`, `tuner_store`, `tuner_hub`) through `ToolContext` → `ToolFactory` → `RoomHub` → `main.py`.

**Tech Stack:** Python 3 / FastAPI / Socket.IO / LangChain `StructuredTool` / LangGraph `interrupt` / Motor (MongoDB) / pytest-asyncio; Playwright for e2e; the offline-deterministic `bloom-tuner` Rust GA via subprocess.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-25-tuner-agent-chat-tuning-design.md`.
- **No Rust, no frontend pane, no new Mongo collection.** Reuse `derive_target` (`app/simulator/targets.py`), `TunerHub.request_tune` (`app/tuner/hub.py`), and `SlotModelStore.put` (`app/simulator/store.py`) verbatim.
- **Intent stays in the GDD.** `set_tuner_params` changes GA knobs only — never RTP / volatility / bonus-rate (those live in the GDD `math-model` doc, edited via the existing `set_gdd_fields`).
- **AI-designed, never AI-decided.** Apply is always gated by a human `interrupt()` approval; never auto-apply.
- **TDD, frequent commits.** Conventional Commits (`feat:` / `test:` / `docs:`). Run the backend suite from `studio/backend` with `uv run pytest`.
- **A skill's `tools:` are validated against `ToolFactory.known_tool_names()`** at load — every new tool must be in `_BUILDERS` before `tune-math.md` will load.
- **Hot files** (`avoid-merge-conflicts`): `agent_tools.py` (`ToolContext`, `_BUILDERS`), `room_hub.py` (`__init__`, `_run_skill`), `main.py` (`build()`). Coordinate with any active chat-feature session; check `git worktree list` before the wiring task. Land fast.

---

## File Structure

- **`studio/backend/app/agent_tools.py`** (modify) — extend `ToolContext` (+3 fields) and `ToolFactory.__init__` (+3 params); add four `build_*_tool` functions; register four `_BUILDERS` keys. Owns the chat-tool surface.
- **`studio/backend/app/room_hub.py`** (modify) — `__init__` accepts + stores `sim_store` / `tuner_store` / `tuner_hub`; `_run_skill` threads them into the `ToolContext` it builds.
- **`studio/backend/app/main.py`** (modify) — pass the already-constructed `sim_store` / `tuner_store` / `tuner_hub` into `ToolFactory(...)` and `RoomHub(...)`.
- **`skills/tune-math.md`** (create) — repo-root skill declaring the four tools + agent guidance.
- **`studio/backend/tests/test_tuner_tools.py`** (create) — unit/integration tests for all four tools (real Mongo stores + `FakeTunerRunner` + monkeypatched `interrupt`).
- **`studio/backend/tests/test_agent_tools.py`** (modify) — update the exact `known_tool_names` assertion as each tool lands.
- **`studio/backend/tests/test_skills_load.py`** (create) — assert `tune-math.md` loads with the four tools.
- **`studio/frontend/e2e/tuner-chat.spec.ts`** (create) + recorded run cassette — the full chat → tune → verdict → apply loop.

---

## Reference signatures (verbatim from the merged backend — consume, do not change)

```python
# app/tuner/store.py
TunerStore.get(game_id) -> TunerJobDoc | None
TunerStore.get_or_seed(game_id) -> TunerJobDoc          # seeds default_tuning_params()
TunerStore.put(game_id, *, params: TuningParams | None) -> TunerJobDoc
TunerStore.save_result(game_id, result: TuneResult) -> TunerJobDoc

# app/tuner/hub.py
TunerHub(sio, tuner_store, slot_model_store, runner, gdd_store)
TunerHub.request_tune(game_id) -> None    # runs GA to completion, emits sockets, save_result; on TargetGap emits tuning_failed and returns (no result saved)

# app/tuner/models.py
TuningParams(master_seed, population, max_generations, search_candidate_count,
             final_candidate_count, elitism, mutation_rate, crossover_rate,
             stagnation_window, weights: TuneWeights)   # _WireModel (camelCase alias)
TuneWeights(rtp, volatility, hit_rate)
TuneResult(status: "pass"|"near_miss"|"error", verdict, tuned_model: dict|None,
           metrics: MetricsWire|None, missed: list[BandMissWire], trace, failure, ran_at)
BandMissWire(metric, measured, band_lo, band_hi)
default_tuning_params() -> TuningParams

# app/tuner/runner.py
TuneProgress(generation, max_generations, best_fitness, best_rtp, best_volatility)
FakeTunerRunner(*, progress: list[TuneProgress], result: TuneResult)

# app/simulator/store.py
SlotModelStore.get(game_id) -> SlotModelDoc | None
SlotModelStore.get_or_seed(game_id) -> SlotModelDoc      # .model (dict), .params (CurationParams)
SlotModelStore.put(game_id, *, model=None, params=None) -> SlotModelDoc

# app/simulator/targets.py
derive_target(math_model: dict, params: CurationParams, num_bonuses: int) -> dict   # raises TargetGap
class TargetGap(Exception): self.message

# app/simulator/models.py
MetricsWire(rtp, volatility, hit_frequency, base_rtp, feature_rtp, bonus_hit_rates: list[float])
```

GDD intent is read with `gdd = await ctx.gdd_store.get_doc(game_id, "math-model")` then `math_model = getattr(gdd, "data", {}) if gdd else {}` (the pattern in `hub.py`).

---

## Task 1: `read_tuner_setup` tool + `ToolContext` plumbing

**Files:**

- Modify: `studio/backend/app/agent_tools.py` (`ToolContext` ~11-20; `ToolFactory.__init__`/`_BUILDERS`)
- Create: `studio/backend/tests/test_tuner_tools.py`
- Modify: `studio/backend/tests/test_agent_tools.py` (`test_known_tool_names`)

**Interfaces:**

- Produces: `ToolContext` fields `sim_store`, `tuner_store`, `tuner_hub` (default `None`); `ToolFactory(asset_store, asset_hub, *, gdd_store=None, gdd_hub=None, scene_store=None, scene_hub=None, sim_store=None, tuner_store=None, tuner_hub=None)`; `_BUILDERS["read_tuner_setup"] = build_read_tuner_setup_tool`; `build_read_tuner_setup_tool(ctx) -> BaseTool` exposing `read_tuner_setup() -> str`.
- Consumes: `SlotModelStore`, `TunerStore`, `derive_target`, `TargetGap`.

- [ ] **Step 1: Write the failing test**

Add to the new `studio/backend/tests/test_tuner_tools.py`:

```python
import pytest

from app.agent_tools import ToolContext, build_read_tuner_setup_tool
from app.simulator.store import SlotModelStore
from app.tuner.store import TunerStore


class _StubGddDoc:
    def __init__(self, data): self.data = data


class _StubGddStore:
    def __init__(self, data): self._data = data
    async def get_doc(self, game_id, key): return _StubGddDoc(self._data)


def _ctx(mongo_db, *, gdd_data):
    return ToolContext(
        "r1", "g1", None, None,
        gdd_store=_StubGddStore(gdd_data),
        sim_store=SlotModelStore(mongo_db),
        tuner_store=TunerStore(mongo_db),
    )


@pytest.mark.asyncio
async def test_read_tuner_setup_reports_params_and_target(mongo_db):
    ctx = _ctx(mongo_db, gdd_data={"rtp": "0.94", "volatility": "high"})
    await ctx.sim_store.get_or_seed("g1")          # model has no bonuses -> no bonus band needed
    tool = build_read_tuner_setup_tool(ctx)
    out = await tool.ainvoke({})
    assert "population" in out.lower()
    assert "0.94" in out                            # derived RTP target
    assert "no tune has run" in out.lower()         # no result yet


@pytest.mark.asyncio
async def test_read_tuner_setup_reports_gap_when_intent_missing(mongo_db):
    ctx = _ctx(mongo_db, gdd_data={})               # no rtp/volatility -> TargetGap
    await ctx.sim_store.get_or_seed("g1")
    tool = build_read_tuner_setup_tool(ctx)
    out = await tool.ainvoke({})
    assert "missing required intent" in out.lower() or "incomplete" in out.lower()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd studio/backend && uv run pytest tests/test_tuner_tools.py -v`
Expected: FAIL — `ImportError: cannot import name 'build_read_tuner_setup_tool'`.

- [ ] **Step 3: Extend `ToolContext` and `ToolFactory`**

In `studio/backend/app/agent_tools.py`, extend the dataclass (after `scene_hub`):

```python
@dataclass
class ToolContext:
    room_id: str
    game_id: str
    asset_store: object
    asset_hub: object
    gdd_store: object = None
    gdd_hub: object = None
    scene_store: object = None
    scene_hub: object = None
    sim_store: object = None
    tuner_store: object = None
    tuner_hub: object = None
```

In `ToolFactory.__init__`, add the three params and store them:

```python
    def __init__(self, asset_store, asset_hub, gdd_store=None, gdd_hub=None,
                 scene_store=None, scene_hub=None,
                 sim_store=None, tuner_store=None, tuner_hub=None):
        self._asset_store = asset_store
        self._asset_hub = asset_hub
        self._gdd_store = gdd_store
        self._gdd_hub = gdd_hub
        self._scene_store = scene_store
        self._scene_hub = scene_hub
        self._sim_store = sim_store
        self._tuner_store = tuner_store
        self._tuner_hub = tuner_hub
```

- [ ] **Step 4: Implement `build_read_tuner_setup_tool` and register it**

Add near the other builders in `agent_tools.py` (import `derive_target`, `TargetGap` at top: `from app.simulator.targets import derive_target, TargetGap`):

```python
def build_read_tuner_setup_tool(ctx: ToolContext) -> BaseTool:
    async def read_tuner_setup() -> str:
        sim_doc = await ctx.sim_store.get_or_seed(ctx.game_id)
        model = sim_doc.model or {}
        num_bonuses = len(model.get("bonuses", []) or [])
        paytable = (model.get("paytable") or {}).get("entries") or []
        tuner_doc = await ctx.tuner_store.get_or_seed(ctx.game_id)
        p = tuner_doc.params

        gdd = await ctx.gdd_store.get_doc(ctx.game_id, "math-model")
        math_model = getattr(gdd, "data", {}) if gdd is not None else {}
        try:
            target = derive_target(math_model, sim_doc.params, num_bonuses)
            target_line = (
                f"target: RTP {target['rtp_target']} ±{target['rtp_tolerance']}, "
                f"volatility {target['volatility_min']}–{target['volatility_max']}, "
                f"{len(target['bonus_hit_rate_bands'])} bonus band(s)"
            )
        except TargetGap as gap:
            target_line = f"target: UNAVAILABLE — {gap.message}"

        result = tuner_doc.result
        if result is None:
            result_line = "last result: no tune has run yet"
        else:
            tuned = "a tuned model is pending Apply" if result.tuned_model else "no tuned model"
            result_line = f"last result: {result.status} ({tuned})"

        return (
            f"Seed model: {len(model.get('reels', []) or [])} reels, "
            f"{model.get('rows', '?')} rows, {len(paytable)} paytable entries, "
            f"{num_bonuses} bonus(es).\n"
            f"GA params: population {p.population}, generations {p.max_generations}, "
            f"search/final candidates {p.search_candidate_count}/{p.final_candidate_count}, "
            f"seed {p.master_seed}, weights rtp/vol/hit "
            f"{p.weights.rtp}/{p.weights.volatility}/{p.weights.hit_rate}.\n"
            f"{target_line}\n{result_line}"
        )

    return StructuredTool.from_function(
        coroutine=read_tuner_setup,
        name="read_tuner_setup",
        description=(
            "Report the slot-math tuner setup for the current game: the seed model "
            "shape, the GA parameters, the derived target bands (from GDD intent), and "
            "the last tune verdict. Read-only. Call this first before tuning."
        ),
    )
```

Add to `_BUILDERS` (after `"realize_symbol"`):

```python
        "read_tuner_setup": build_read_tuner_setup_tool,
```

- [ ] **Step 5: Update the `known_tool_names` assertion**

In `studio/backend/tests/test_agent_tools.py`, add `"read_tuner_setup",` to the expected set in `test_known_tool_names`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd studio/backend && uv run pytest tests/test_tuner_tools.py tests/test_agent_tools.py::test_known_tool_names -v`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/tests/test_tuner_tools.py studio/backend/tests/test_agent_tools.py
git commit -m "feat(tuner): read_tuner_setup chat tool + ToolContext tuner plumbing"
```

---

## Task 2: `set_tuner_params` tool

**Files:**

- Modify: `studio/backend/app/agent_tools.py`
- Modify: `studio/backend/tests/test_tuner_tools.py`
- Modify: `studio/backend/tests/test_agent_tools.py` (`test_known_tool_names`)

**Interfaces:**

- Produces: `_BUILDERS["set_tuner_params"] = build_set_tuner_params_tool`; tool `set_tuner_params(master_seed?, population?, max_generations?, search_candidate_count?, final_candidate_count?, elitism?, mutation_rate?, crossover_rate?, stagnation_window?, weight_rtp?, weight_volatility?, weight_hit_rate?) -> str`.
- Consumes: `TunerStore.get_or_seed`/`put`, `TuningParams`, `TuneWeights`.

- [ ] **Step 1: Write the failing test**

Append to `studio/backend/tests/test_tuner_tools.py`:

```python
from app.agent_tools import build_set_tuner_params_tool
from app.tuner.store import TunerStore as _TS


def _params_ctx(mongo_db):
    return ToolContext("r1", "g1", None, None, tuner_store=_TS(mongo_db))


@pytest.mark.asyncio
async def test_set_tuner_params_patches_only_given_fields(mongo_db):
    ctx = _params_ctx(mongo_db)
    seeded = await ctx.tuner_store.get_or_seed("g1")
    tool = build_set_tuner_params_tool(ctx)
    out = await tool.ainvoke({"population": 48, "weight_rtp": 2.0})
    doc = await ctx.tuner_store.get("g1")
    assert doc.params.population == 48
    assert doc.params.weights.rtp == 2.0
    assert doc.params.max_generations == seeded.params.max_generations   # untouched
    assert doc.params.weights.volatility == seeded.params.weights.volatility
    assert "48" in out


@pytest.mark.asyncio
async def test_set_tuner_params_rejects_nonpositive_without_writing(mongo_db):
    ctx = _params_ctx(mongo_db)
    await ctx.tuner_store.get_or_seed("g1")
    tool = build_set_tuner_params_tool(ctx)
    out = await tool.ainvoke({"population": 0})
    assert "must be positive" in out.lower()
    doc = await ctx.tuner_store.get("g1")
    assert doc.params.population != 0       # no write happened
```

- [ ] **Step 2: Run to verify failure**

Run: `cd studio/backend && uv run pytest tests/test_tuner_tools.py -k set_tuner_params -v`
Expected: FAIL — `ImportError: cannot import name 'build_set_tuner_params_tool'`.

- [ ] **Step 3: Implement the tool and register it**

Add to `agent_tools.py` (import at top: `from app.tuner.models import TuningParams`):

```python
def build_set_tuner_params_tool(ctx: ToolContext) -> BaseTool:
    _POSITIVE = ("population", "max_generations", "search_candidate_count",
                 "final_candidate_count", "stagnation_window")

    async def set_tuner_params(
        master_seed: int | None = None,
        population: int | None = None,
        max_generations: int | None = None,
        search_candidate_count: int | None = None,
        final_candidate_count: int | None = None,
        elitism: int | None = None,
        mutation_rate: float | None = None,
        crossover_rate: float | None = None,
        stagnation_window: int | None = None,
        weight_rtp: float | None = None,
        weight_volatility: float | None = None,
        weight_hit_rate: float | None = None,
    ) -> str:
        scalars = {
            "master_seed": master_seed, "population": population,
            "max_generations": max_generations,
            "search_candidate_count": search_candidate_count,
            "final_candidate_count": final_candidate_count, "elitism": elitism,
            "mutation_rate": mutation_rate, "crossover_rate": crossover_rate,
            "stagnation_window": stagnation_window,
        }
        for key in _POSITIVE:
            v = scalars[key]
            if v is not None and v <= 0:
                return f"'{key}' must be positive (got {v}); no change made."
        if elitism is not None and elitism < 0:
            return f"'elitism' must be >= 0 (got {elitism}); no change made."

        doc = await ctx.tuner_store.get_or_seed(ctx.game_id)
        data = doc.params.model_dump()
        for key, v in scalars.items():
            if v is not None:
                data[key] = v
        weights = dict(data["weights"])
        if weight_rtp is not None:
            weights["rtp"] = weight_rtp
        if weight_volatility is not None:
            weights["volatility"] = weight_volatility
        if weight_hit_rate is not None:
            weights["hit_rate"] = weight_hit_rate
        data["weights"] = weights

        updated = TuningParams.model_validate(data)
        await ctx.tuner_store.put(ctx.game_id, params=updated)
        return (
            f"Updated tuner GA params: population {updated.population}, "
            f"generations {updated.max_generations}, seed {updated.master_seed}, "
            f"weights rtp/vol/hit "
            f"{updated.weights.rtp}/{updated.weights.volatility}/{updated.weights.hit_rate}."
        )

    return StructuredTool.from_function(
        coroutine=set_tuner_params,
        name="set_tuner_params",
        description=(
            "Adjust the genetic-algorithm tuning knobs (population, generations, "
            "candidate counts, master seed, and the rtp/volatility/hit_rate fitness "
            "weights). Only the fields you pass change. This does NOT set the design "
            "target (RTP / volatility / bonus rate) — that lives in the GDD math-model; "
            "edit it with set_gdd_fields instead."
        ),
    )
```

Register in `_BUILDERS`:

```python
        "set_tuner_params": build_set_tuner_params_tool,
```

- [ ] **Step 4: Update `known_tool_names`**

Add `"set_tuner_params",` to the expected set in `test_agent_tools.py::test_known_tool_names`.

- [ ] **Step 5: Run to verify pass**

Run: `cd studio/backend && uv run pytest tests/test_tuner_tools.py tests/test_agent_tools.py::test_known_tool_names -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/tests/test_tuner_tools.py studio/backend/tests/test_agent_tools.py
git commit -m "feat(tuner): set_tuner_params chat tool (GA knobs only)"
```

---

## Task 3: `tune_slot_model` tool

**Files:**

- Modify: `studio/backend/app/agent_tools.py`
- Modify: `studio/backend/tests/test_tuner_tools.py`
- Modify: `studio/backend/tests/test_agent_tools.py` (`test_known_tool_names`)

**Interfaces:**

- Produces: `_BUILDERS["tune_slot_model"] = build_tune_slot_model_tool`; tool `tune_slot_model() -> str`.
- Consumes: `ctx.tuner_hub.request_tune`, `ctx.tuner_store.get`, `ctx.sim_store.get_or_seed`, `ctx.gdd_store.get_doc`, `derive_target`/`TargetGap`.

- [ ] **Step 1: Write the failing test**

Append to `studio/backend/tests/test_tuner_tools.py`:

```python
from app.agent_tools import build_tune_slot_model_tool
from app.tuner.hub import TunerHub
from app.tuner.runner import FakeTunerRunner, TuneProgress
from app.tuner.models import TuneResult, BandMissWire
from app.simulator.models import MetricsWire


class _FakeSio:
    def __init__(self): self.events = []
    async def enter_room(self, sid, room): pass
    async def emit(self, event, data, **kw): self.events.append((event, data))


def _metrics(rtp): return MetricsWire(rtp=rtp, volatility=8.0, hit_frequency=0.3,
                                      base_rtp=rtp, feature_rtp=0.0, bonus_hit_rates=[])


def _tune_ctx(mongo_db, *, result):
    sim = SlotModelStore(mongo_db)
    tuner = TunerStore(mongo_db)
    gdd = _StubGddStore({"rtp": "0.94", "volatility": "high"})   # no bonuses needed
    runner = FakeTunerRunner(
        progress=[TuneProgress(1, 40, 0.5, 0.90, 8.0)], result=result)
    hub = TunerHub(_FakeSio(), tuner, sim, runner, gdd)
    return ToolContext("r1", "g1", None, None, gdd_store=gdd,
                       sim_store=sim, tuner_store=tuner, tuner_hub=hub)


@pytest.mark.asyncio
async def test_tune_slot_model_reports_pass(mongo_db):
    passing = TuneResult(status="pass", verdict="pass", tuned_model={"reels": []},
                         metrics=_metrics(0.94), missed=[], trace=[], ran_at="t1")
    ctx = _tune_ctx(mongo_db, result=passing)
    await ctx.sim_store.get_or_seed("g1")
    tool = build_tune_slot_model_tool(ctx)
    out = await tool.ainvoke({})
    assert "pass" in out.lower()
    assert "0.94" in out
    saved = await ctx.tuner_store.get("g1")
    assert saved.result.tuned_model == {"reels": []}    # request_tune persisted it


@pytest.mark.asyncio
async def test_tune_slot_model_reports_near_miss_with_missed_bands(mongo_db):
    near = TuneResult(status="near_miss", verdict="near_miss", tuned_model={"reels": []},
                      metrics=_metrics(0.91),
                      missed=[BandMissWire(metric="rtp", measured=0.91,
                                           band_lo=0.93, band_hi=0.95)],
                      trace=[], ran_at="t1")
    ctx = _tune_ctx(mongo_db, result=near)
    await ctx.sim_store.get_or_seed("g1")
    tool = build_tune_slot_model_tool(ctx)
    out = await tool.ainvoke({})
    assert "near" in out.lower()
    assert "rtp" in out.lower() and "0.91" in out


@pytest.mark.asyncio
async def test_tune_slot_model_reports_gap_without_running(mongo_db):
    ctx = _tune_ctx(mongo_db, result=None)              # runner result unused
    ctx.gdd_store = _StubGddStore({})                   # missing intent -> TargetGap
    await ctx.sim_store.get_or_seed("g1")
    tool = build_tune_slot_model_tool(ctx)
    out = await tool.ainvoke({})
    assert "missing required intent" in out.lower() or "incomplete" in out.lower()
    saved = await ctx.tuner_store.get("g1")
    assert saved is None or saved.result is None        # never ran
```

(Note: `FakeTunerRunner(result=None)` is acceptable here because the gap path returns before the runner is invoked.)

- [ ] **Step 2: Run to verify failure**

Run: `cd studio/backend && uv run pytest tests/test_tuner_tools.py -k tune_slot_model -v`
Expected: FAIL — `ImportError: cannot import name 'build_tune_slot_model_tool'`.

- [ ] **Step 3: Implement the tool and register it**

Add to `agent_tools.py`:

```python
def build_tune_slot_model_tool(ctx: ToolContext) -> BaseTool:
    async def tune_slot_model() -> str:
        sim_doc = await ctx.sim_store.get_or_seed(ctx.game_id)
        model = sim_doc.model or {}
        num_bonuses = len(model.get("bonuses", []) or [])
        gdd = await ctx.gdd_store.get_doc(ctx.game_id, "math-model")
        math_model = getattr(gdd, "data", {}) if gdd is not None else {}
        try:
            derive_target(math_model, sim_doc.params, num_bonuses)   # gap pre-check
        except TargetGap as gap:
            return (f"Cannot tune: {gap.message}. Complete the GDD math-model intent "
                    f"(RTP, volatility, bonus rate) first, then tune again.")

        before = await ctx.tuner_store.get(ctx.game_id)
        before_ran = before.result.ran_at if (before and before.result) else None

        await ctx.tuner_hub.request_tune(ctx.game_id)   # runs GA, streams to the pane

        after = await ctx.tuner_store.get(ctx.game_id)
        result = after.result if after else None
        if result is None or result.ran_at == before_ran:
            return ("The tune did not produce a result — check the Tuner pane or the "
                    "backend logs for a failure.")

        m = result.metrics
        head = (f"measured RTP {m.rtp}, volatility {m.volatility}, "
                f"hit-frequency {m.hit_frequency}") if m else "no metrics"
        if result.status == "pass":
            return (f"Tuned to PASS — {head}. A tuned model is ready; say 'apply it' "
                    f"to write it into the slot model (a human confirms).")
        if result.status == "near_miss":
            misses = "; ".join(
                f"{x.metric} measured {x.measured}, needs {x.band_lo}–{x.band_hi}"
                for x in result.missed) or "see the Tuner pane"
            return (f"Tuned to NEAR-MISS — {head}. Missed: {misses}. Try raising "
                    f"candidate counts / generations, re-weighting, or relaxing the "
                    f"GDD intent, then tune again.")
        return f"Tuning failed: {result.failure or 'unknown error'}."

    return StructuredTool.from_function(
        coroutine=tune_slot_model,
        name="tune_slot_model",
        description=(
            "Run the genetic tuner on the current slot model toward the GDD design "
            "intent, to completion, and report the verdict (PASS / NEAR-MISS) with "
            "measured RTP, volatility, and hit-rates. Live convergence shows in the "
            "Tuner pane. Does NOT apply the result — use apply_tuned_model for that."
        ),
    )
```

Register in `_BUILDERS`:

```python
        "tune_slot_model": build_tune_slot_model_tool,
```

- [ ] **Step 4: Update `known_tool_names`**

Add `"tune_slot_model",` to the expected set in `test_agent_tools.py::test_known_tool_names`.

- [ ] **Step 5: Run to verify pass**

Run: `cd studio/backend && uv run pytest tests/test_tuner_tools.py tests/test_agent_tools.py::test_known_tool_names -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/tests/test_tuner_tools.py studio/backend/tests/test_agent_tools.py
git commit -m "feat(tuner): tune_slot_model chat tool (run to completion + report verdict)"
```

---

## Task 4: `apply_tuned_model` tool (human-gated)

**Files:**

- Modify: `studio/backend/app/agent_tools.py`
- Modify: `studio/backend/tests/test_tuner_tools.py`
- Modify: `studio/backend/tests/test_agent_tools.py` (`test_known_tool_names`)

**Interfaces:**

- Produces: `_BUILDERS["apply_tuned_model"] = build_apply_tuned_model_tool`; tool `apply_tuned_model() -> str`.
- Consumes: `ctx.tuner_store.get`, `ctx.sim_store.put`, module-level `interrupt`.

- [ ] **Step 1: Write the failing test**

Append to `studio/backend/tests/test_tuner_tools.py` (import the module to monkeypatch `interrupt`, mirroring the delete-asset tests):

```python
import app.agent_tools as agent_tools
from app.agent_tools import build_apply_tuned_model_tool


async def _seed_result_with_model(tuner_store, model):
    await tuner_store.get_or_seed("g1")
    await tuner_store.save_result("g1", TuneResult(
        status="pass", verdict="pass", tuned_model=model, metrics=_metrics(0.94),
        missed=[], trace=[], ran_at="t1"))


def _apply_ctx(mongo_db):
    return ToolContext("r1", "g1", None, None,
                       sim_store=SlotModelStore(mongo_db), tuner_store=TunerStore(mongo_db))


@pytest.mark.asyncio
async def test_apply_tuned_model_approve_writes_back(mongo_db, monkeypatch):
    monkeypatch.setattr(agent_tools, "interrupt", lambda payload: "approve")
    ctx = _apply_ctx(mongo_db)
    await ctx.sim_store.get_or_seed("g1")
    await _seed_result_with_model(ctx.tuner_store, {"reels": [["A"]]})
    tool = build_apply_tuned_model_tool(ctx)
    out = await tool.ainvoke({})
    assert "applied" in out.lower()
    doc = await ctx.sim_store.get("g1")
    assert doc.model == {"reels": [["A"]]}


@pytest.mark.asyncio
async def test_apply_tuned_model_deny_leaves_model_unchanged(mongo_db, monkeypatch):
    monkeypatch.setattr(agent_tools, "interrupt", lambda payload: "deny")
    ctx = _apply_ctx(mongo_db)
    await ctx.sim_store.get_or_seed("g1")               # model == {}
    await _seed_result_with_model(ctx.tuner_store, {"reels": [["A"]]})
    tool = build_apply_tuned_model_tool(ctx)
    out = await tool.ainvoke({})
    assert "declined" in out.lower()
    doc = await ctx.sim_store.get("g1")
    assert doc.model == {}


@pytest.mark.asyncio
async def test_apply_tuned_model_no_result_returns_friendly(mongo_db, monkeypatch):
    def _boom(payload): raise AssertionError("interrupt must not be called")
    monkeypatch.setattr(agent_tools, "interrupt", _boom)
    ctx = _apply_ctx(mongo_db)
    tool = build_apply_tuned_model_tool(ctx)
    out = await tool.ainvoke({})
    assert "run a tune first" in out.lower()
```

- [ ] **Step 2: Run to verify failure**

Run: `cd studio/backend && uv run pytest tests/test_tuner_tools.py -k apply_tuned_model -v`
Expected: FAIL — `ImportError: cannot import name 'build_apply_tuned_model_tool'`.

- [ ] **Step 3: Implement the tool and register it**

Add to `agent_tools.py` (`interrupt` is already imported at the top: `from langgraph.types import interrupt`):

```python
def build_apply_tuned_model_tool(ctx: ToolContext) -> BaseTool:
    async def apply_tuned_model() -> str:
        doc = await ctx.tuner_store.get(ctx.game_id)
        tuned = doc.result.tuned_model if (doc and doc.result) else None
        if not tuned:
            return "No tuned model to apply yet — run a tune first."
        label = ("Apply the tuned model to the slot model? This overwrites the "
                 "current realization.")
        decision = interrupt(
            {"tool": "apply_tuned_model", "args": {}, "label": label})
        if decision != "approve":
            return "Apply declined by the user; the slot model is unchanged."
        await ctx.sim_store.put(ctx.game_id, model=tuned)
        return ("Applied the tuned model to the slot model. Re-curate (in the "
                "Simulator) to confirm it still passes.")

    return StructuredTool.from_function(
        coroutine=apply_tuned_model,
        name="apply_tuned_model",
        description=(
            "Apply the most recent tuned slot model into the game's slot model, "
            "overwriting the current realization. Destructive; the studio asks the "
            "human to approve before it runs. Call only after a tune produced a model."
        ),
    )
```

Register in `_BUILDERS`:

```python
        "apply_tuned_model": build_apply_tuned_model_tool,
```

- [ ] **Step 4: Update `known_tool_names`**

Add `"apply_tuned_model",` to the expected set in `test_agent_tools.py::test_known_tool_names`.

- [ ] **Step 5: Run to verify pass (full backend suite)**

Run: `cd studio/backend && uv run pytest tests/test_tuner_tools.py tests/test_agent_tools.py -v`
Expected: PASS (all tuner-tool tests + the updated `known_tool_names`).

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/tests/test_tuner_tools.py studio/backend/tests/test_agent_tools.py
git commit -m "feat(tuner): apply_tuned_model chat tool (human-gated write-back)"
```

---

## Task 5: Thread `sim_store` / `tuner_store` / `tuner_hub` through `RoomHub` and `main.py`

**Files:**

- Modify: `studio/backend/app/room_hub.py` (`__init__` ~14-43; `_run_skill` `ToolContext(...)` ~282-284)
- Modify: `studio/backend/app/main.py` (`ToolFactory(...)` ~106-107; `RoomHub(...)` ~113-120)
- Modify: `studio/backend/tests/test_room_hub.py` (or create `tests/test_room_hub_wiring.py` if no such file exists)

**Interfaces:**

- Consumes: the three tool deps from Task 1's `ToolContext`/`ToolFactory`.
- Produces: `RoomHub(__init__)` keyword params `sim_store=None`, `tuner_store=None`, `tuner_hub=None` stored as `self._sim_store` / `self._tuner_store` / `self._tuner_hub`, threaded into the `ToolContext` built by `_run_skill`.

- [ ] **Step 1: Write the failing test**

If `studio/backend/tests/test_room_hub.py` exists, add this test there; otherwise create `studio/backend/tests/test_room_hub_wiring.py`:

```python
from app.room_hub import RoomHub


def test_room_hub_stores_tuner_dependencies():
    hub = RoomHub(
        sio=None, store=None, chat_service=None,
        sim_store="SIM", tuner_store="TUNER", tuner_hub="HUB",
    )
    assert hub._sim_store == "SIM"
    assert hub._tuner_store == "TUNER"
    assert hub._tuner_hub == "HUB"
```

- [ ] **Step 2: Run to verify failure**

Run: `cd studio/backend && uv run pytest tests/test_room_hub_wiring.py -v` (or the path you added it to)
Expected: FAIL — `TypeError: __init__() got an unexpected keyword argument 'sim_store'`.

- [ ] **Step 3: Extend `RoomHub.__init__`**

In `studio/backend/app/room_hub.py`, add three keyword params after `scene_hub=None,` in the signature:

```python
        scene_store=None,
        scene_hub=None,
        sim_store=None,
        tuner_store=None,
        tuner_hub=None,
    ):
```

and store them alongside the existing assignments (after `self._scene_hub = scene_hub`):

```python
        self._sim_store = sim_store
        self._tuner_store = tuner_store
        self._tuner_hub = tuner_hub
```

- [ ] **Step 4: Thread them into the `_run_skill` `ToolContext`**

In `room_hub.py` `_run_skill`, extend the `ToolContext(...)` construction (~line 282):

```python
        ctx = ToolContext(room_id, room.game_id, self._asset_store, self._asset_hub,
                         gdd_store=self._gdd_store, gdd_hub=self._gdd_hub,
                         scene_store=self._scene_store, scene_hub=self._scene_hub,
                         sim_store=self._sim_store, tuner_store=self._tuner_store,
                         tuner_hub=self._tuner_hub)
```

- [ ] **Step 5: Wire `main.py` `build()`**

In `studio/backend/app/main.py`, pass the existing objects into `ToolFactory(...)` (~line 106):

```python
    tool_factory = ToolFactory(asset_store, asset_hub, gdd_store=gdd_store, gdd_hub=gdd_hub,
                               scene_store=scene_store, scene_hub=scene_hub,
                               sim_store=sim_store, tuner_store=tuner_store,
                               tuner_hub=tuner_hub)
```

and into `RoomHub(...)` (~line 119, after `scene_store=scene_store, scene_hub=scene_hub,`):

```python
        sim_store=sim_store, tuner_store=tuner_store, tuner_hub=tuner_hub,
```

- [ ] **Step 6: Run to verify pass (and that nothing regressed)**

Run: `cd studio/backend && uv run pytest -q`
Expected: PASS — the new wiring test plus the full existing suite green.

- [ ] **Step 7: Commit**

```bash
git add studio/backend/app/room_hub.py studio/backend/app/main.py studio/backend/tests/
git commit -m "feat(tuner): thread sim/tuner stores + hub into RoomHub and main build"
```

---

## Task 6: `tune-math` skill

**Files:**

- Create: `skills/tune-math.md` (repo root)
- Create: `studio/backend/tests/test_skills_load.py`

**Interfaces:**

- Consumes: all four `_BUILDERS` keys from Tasks 1-4 (the skill's `tools:` are validated against `known_tool_names()`).
- Produces: a loadable skill named `tune-math`.

- [ ] **Step 1: Write the failing test**

Create `studio/backend/tests/test_skills_load.py`:

```python
from pathlib import Path

from app.agent_tools import ToolFactory
from app.skills import SkillRegistry

_SKILLS_DIR = Path(__file__).resolve().parents[3] / "skills"


def test_tune_math_skill_loads_with_four_tools():
    reg = SkillRegistry(_SKILLS_DIR, ToolFactory(None, None).known_tool_names())
    reg.load()
    spec = reg.get("tune-math")
    assert spec is not None
    assert set(spec.tools) == {
        "read_tuner_setup", "set_tuner_params", "tune_slot_model", "apply_tuned_model",
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cd studio/backend && uv run pytest tests/test_skills_load.py -v`
Expected: FAIL — `reg.get("tune-math")` is `None` (skill file does not exist yet).

(If the `SkillRegistry` / `.get` API differs from this, adjust the test to the real API discovered in `app/skills.py` — keep the assertion that the skill loads with exactly those four tools.)

- [ ] **Step 3: Create the skill**

Create `skills/tune-math.md`:

```markdown
---
name: tune-math
description: Tune the slot model's math (reels + paytable + bonus) toward the
  game's design intent, then optionally apply the result. Applying is confirmed
  by a human.
args:
  - { name: focus, type: string, required: false, description: 'Optional nudge, e.g. "lower volatility" or "use a bigger population".' }
tools: [read_tuner_setup, set_tuner_params, tune_slot_model, apply_tuned_model]
---

You tune a casino slot game's math so the realized model hits the design intent
recorded in the GDD (RTP, volatility, bonus hit-rate).

Work in this order:

1. GROUND. Call `read_tuner_setup` first to see the seed model shape, the current
   GA parameters, the derived target bands, and any prior verdict. If the target
   is UNAVAILABLE because the GDD intent is incomplete, tell the user to fill the
   RTP / volatility / bonus rate in the GDD (the design-game skill) — do NOT invent
   intent here.

2. ADJUST (only if asked). If the user wants a different search — a bigger
   population, more generations, a different fitness weighting, a fixed seed — call
   `set_tuner_params` with just those fields. Never set the design target here;
   that is the GDD's job.

3. TUNE. Call `tune_slot_model`. It runs the genetic search to completion and
   reports PASS or NEAR-MISS with measured RTP, volatility, and hit-rates; live
   convergence shows in the Tuner pane. On NEAR-MISS, explain which band was missed
   and suggest a concrete next step (raise candidate counts / generations, re-weight,
   or relax the GDD intent).

4. APPLY (only on the user's say-so). If the tune passed and the user wants to keep
   it, call `apply_tuned_model`. The studio asks the human to approve before it
   overwrites the slot model — the tuned math is AI-designed but human-decided.
   After applying, suggest re-curating in the Simulator to confirm.

Be concise. Report real numbers, not vibes.
```

- [ ] **Step 4: Run to verify pass**

Run: `cd studio/backend && uv run pytest tests/test_skills_load.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/tune-math.md studio/backend/tests/test_skills_load.py
git commit -m "feat(tuner): tune-math skill exposing the four tuning tools"
```

---

## Task 7: Playwright e2e — full chat → tune → verdict → apply loop

**Files:**

- Create: `studio/frontend/e2e/tuner-chat.spec.ts`
- Create: the recorded run cassette for the agent's tool-calling turn (path per the existing run-cassette convention; discover it from `studio/backend` cassette config and the agentic-skill-chat e2e specs).

**Interfaces:**

- Consumes: the four tools + `tune-math` skill from Tasks 1-6, wired end-to-end via Task 5.
- Produces: deterministic client-level proof of the chat tuning loop.

**Prerequisites / context for the implementer:**

- Per `AGENTS.md`: the e2e suite runs against a **replay** backend (`just backend-serve-replay`) and is run locally (`just e2e`), never in CI. The tuner itself is offline/deterministic and needs **no** cassette; only the chat LLM's tool-calling turn does.
- This worktree uses `BLOOM_PORT_OFFSET=1` → backend `:8001`, frontend `:4201`. The Playwright/Vite configs derive ports from the offset already.
- Recording the cassette requires a **live** provider session (`PROVIDER_MODE=live`, `just record-fixtures` / the project's run-cassette recorder) to capture the agent calling `tune_slot_model` then `apply_tuned_model`. Recording is a singleton (one live session at a time — see the worktree notes). Commit the recorded cassette so replay is deterministic.

- [ ] **Step 1: Study the existing pattern**

Read `studio/frontend/e2e/tuner.spec.ts` (the pane-level tuner e2e) for how a game is seeded with a detuned model + GDD intent, and read an agentic-skill-chat e2e spec (e.g. the one exercising a skill run with a run cassette) for how a chat turn is driven and how its cassette is recorded/keyed. Note the exact backend seeding helpers and the chat-input selectors/testids they use.

- [ ] **Step 2: Write the e2e spec**

Create `studio/frontend/e2e/tuner-chat.spec.ts` following the discovered helpers. The spec MUST:

1. Seed a game with a **detuned** slot model (off-target RTP) and a complete GDD `math-model` intent (RTP, volatility, and — if the model has bonuses — bonus rate), reusing `tuner.spec.ts`'s seeding helper.
2. Open the game room chat and invoke the tuning skill (e.g. type a prompt that routes to `tune-math`, or `/tune-math`, per the natural-invocation/`design-game` precedent).
3. Assert the **PASS verdict text appears in the chat feed** — anchor on the deterministic tool-output string from `tune_slot_model` (e.g. text matching `/Tuned to PASS/i` and the measured RTP), since that string is produced by our tool, not the LLM's free prose.
4. Optionally assert the Tuner pane reflects a completed run (it receives the same `tuning_complete` socket event).
5. Tell the agent to apply (e.g. "apply it"); assert the **approval prompt surfaces** (the `interrupt()` UI — reuse the approve-control selector from the slice-3 `delete_asset` e2e), approve it.
6. Assert the **write-back**: re-read the slot model via its REST endpoint (`GET /games/:id/slot-model`) or the Simulator pane and confirm the model now equals the tuned model (changed from the detuned seed).

- [ ] **Step 3: Record the run cassette**

With the backend in live mode, run the spec once to capture the agent's tool-calling turn(s) into a run cassette (per the project's recorder — the agentic-skill-chat specs established this; mirror their `just record-fixtures` / recording flow). Verify the cassette file is created and committed.

- [ ] **Step 4: Run the spec against replay to verify pass**

Run (from this worktree, with a replay backend on :8001 already started via `just backend-serve-replay`):

```bash
just e2e -- tuner-chat.spec.ts
```

Expected: PASS — the chat loop drives a real tune to PASS, surfaces + approves the apply gate, and the slot model is overwritten with the tuned model.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/e2e/tuner-chat.spec.ts <recorded-cassette-path>
git commit -m "test(tuner): e2e chat tuning loop (tune -> verdict -> approve -> apply)"
```

---

## Final verification (before opening the PR)

Per `frontend-ci-gates` + the tuner-studio process lesson, run ALL gates, not just the test runners — vitest/pytest can pass while typecheck or fmt fail:

- [ ] Backend: `cd studio/backend && uv run pytest -q` — all green.
- [ ] Backend lint/format if configured (e.g. `ruff` / `prettier` over docs): repo prettier gate `npx prettier --check .` from repo root (the `docs/*.md` and any TS).
- [ ] Frontend (the four gates): from `studio/frontend` root — `npx prettier --check .`, `nx typecheck`, `nx test`, `nx build`.
- [ ] e2e: `just e2e -- tuner-chat.spec.ts` against the replay backend (and a full `just e2e` if time permits, to catch cross-spec regressions).
- [ ] `git worktree list` — confirm no sibling session also edited `agent_tools.py` / `room_hub.py` / `main.py`; rebase onto latest `main` if it moved.

Then push and open the PR (`main` is protected — PR is the only path):

```bash
git push -u origin feat/tuner-agent
gh pr create --fill
```

---

## Self-review notes (author)

- **Spec coverage:** §3.1→Task 1, §3.2→Task 2, §3.3→Task 3, §3.4→Task 4, §4 wiring→Tasks 1+5, §4.1 skill→Task 6, §6.1 backend tests→Tasks 1-4 tests, §6.2 e2e→Task 7. §2.2 (read-result-after-await) realized in Task 3's freshness check. All spec sections map to a task.
- **Intent boundary** (`set_tuner_params` never touches RTP/vol/bonus) enforced by the tool surface and stated in its description + the skill body.
- **Apply gating** uses the exact `interrupt()` + `monkeypatch agent_tools.interrupt` pattern from the merged `delete_asset` tests — consistency confirmed against `tests/test_agent_tools.py`.
- **Type consistency:** `derive_target(math_model, params, num_bonuses)`, `TunerStore.put(game_id, *, params=)`, `SlotModelStore.put(game_id, *, model=)`, `TuneResult` fields, `FakeTunerRunner(*, progress=, result=)`, `TuneProgress(generation, max_generations, best_fitness, best_rtp, best_volatility)`, `MetricsWire(...)` all copied verbatim from the merged source read during planning.

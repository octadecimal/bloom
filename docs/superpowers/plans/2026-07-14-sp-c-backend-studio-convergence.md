# SP-C — Backend + Studio Family Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the merged family-aware Rust math toolchain (SP-A #197, SP-B #203) reachable from the studio: family dispatch in `app/math`, math fields folded onto `game_definitions`, a family-aware math pane with dead-feature visibility, the game-structure verify verdict, `derive_target` wired into composed builds, and the agent-tool pass (#189, #190).

**Architecture:** One backend descriptor (`MathStore.family`) answers "what family is this game"; `MathStore` internally dispatches persistence between `slot_models` and `game_definitions` (folded fields), so the hub, REST routes, and agent tools keep their existing `SlotModelDoc`-shaped interface where `doc.model` is _the artifact_ (SlotModel or GameDefinition — the artifact JSON itself carries `family`, which the Rust binaries sniff). The frontend fetches a descriptor, then loads the artifact via the existing per-family GETs.

**Tech Stack:** FastAPI + Motor/Mongo + pydantic (backend), React + hookstate + vitest (frontend), Playwright (e2e), existing Rust binaries (no Rust changes).

**Spec:** `docs/superpowers/specs/2026-07-14-sp-c-backend-studio-convergence-design.md` (read it first).

## Global Constraints

- Conventional Commits for every commit (`feat(math): …`, `test: …`).
- TDD: failing test first, minimal code, then refactor. pytest lives in `studio/backend/tests`; vitest colocated `*.spec.ts(x)`.
- TypeScript interfaces use an `I` prefix (`IComposeVerdict`).
- Studio UI follows `docs/design-language.md`; no raw colors outside `styles.css`.
- Frontend gates before any push: `node_modules/.bin/prettier --check .`, `npx nx typecheck frontend`, `npx nx test frontend`, `npx nx build frontend` (vitest green ≠ types valid).
- Backend tests: `uv --directory studio/backend run pytest -q`.
- The two families are append-only enum dispatch (`match`/`if` on `"slots@1" | "composed@1"`) — no registries, no trait frameworks.
- The legacy slots wire must not change shape: existing slots tests and e2e specs stay green.
- Worktree: `C:\code\bloom.wt\sp-c-family-dispatch`, `BLOOM_PORT_OFFSET=2` (backend :8002, frontend :4202). Never use the default ports. Copy `studio/backend/.env` from the primary checkout (wt-new doesn't).

---

### Task 1: Backend — family descriptor on MathStore + REST route

**Files:**

- Modify: `studio/backend/app/math/store.py` (MathStore ctor + `family()`)
- Modify: `studio/backend/app/math/rest.py` (descriptor route)
- Modify: `studio/backend/app/main.py:118,131` (construction order + wiring)
- Test: `studio/backend/tests/test_math_descriptor.py` (create)

**Interfaces:**

- Produces: `MathStore.family(game_id: str) -> str` (async; returns `"slots@1"` or `"composed@1"`); `MathStore(db, on_change=None, compose_store=None, gdd_store=None)`; `GET /games/{game_id}/math/descriptor` → `{"family": "slots@1" | "composed@1"}`.
- Resolution order: GDD `math-model` doc's `data["game_family"]` if it is one of the two literals (forward-compat with SP-D) → `game_definitions` doc exists → `slot_models` doc exists → default `"slots@1"`. The composed-doc check MUST precede the slots-doc check: legacy pane code may have auto-seeded a stray `slot_models` doc for a composed game.

- [ ] **Step 1: Write the failing tests**

```python
# studio/backend/tests/test_math_descriptor.py
"""MathStore.family — the one backend answer to 'what family is this game'."""
import pytest

from app.math.store import MathStore


class _FakeGddStore:
    def __init__(self, math_model_data=None):
        self._data = math_model_data

    async def get_doc(self, game_id, aspect):
        if aspect == "math-model" and self._data is not None:
            class _Doc:
                data = self._data
            return _Doc()
        return None


class _FakeComposeStore:
    def __init__(self, has_doc: bool):
        self._has = has_doc

    async def get(self, game_id):
        return object() if self._has else None


def _store(mongo_db, *, compose_has=False, gdd_data=None):
    return MathStore(mongo_db, compose_store=_FakeComposeStore(compose_has),
                     gdd_store=_FakeGddStore(gdd_data))


@pytest.mark.asyncio
async def test_gdd_game_family_wins(mongo_db):
    store = _store(mongo_db, compose_has=False,
                   gdd_data={"game_family": "composed@1"})
    assert await store.family("g1") == "composed@1"


@pytest.mark.asyncio
async def test_composed_doc_beats_stray_slots_doc(mongo_db):
    store = _store(mongo_db, compose_has=True)
    await store.get_or_seed("g1")  # stray slots doc, as legacy panes created
    assert await store.family("g1") == "composed@1"


@pytest.mark.asyncio
async def test_slots_doc_resolves_slots(mongo_db):
    store = _store(mongo_db, compose_has=False)
    await store.get_or_seed("g1")
    assert await store.family("g1") == "slots@1"


@pytest.mark.asyncio
async def test_no_docs_defaults_slots(mongo_db):
    store = _store(mongo_db, compose_has=False)
    assert await store.family("nope") == "slots@1"


@pytest.mark.asyncio
async def test_bogus_gdd_family_is_ignored(mongo_db):
    store = _store(mongo_db, compose_has=True, gdd_data={"game_family": "weird"})
    assert await store.family("g1") == "composed@1"
```

Use the same `mongo_db` fixture the existing store tests use (see `studio/backend/tests/conftest.py` — mirror however `test_math_store.py`/similar get a db handle; if the suite uses `mongomock_motor`, follow that pattern exactly).

- [ ] **Step 2: Run to verify failure**

Run: `uv --directory studio/backend run pytest tests/test_math_descriptor.py -q`
Expected: FAIL — `TypeError: MathStore.__init__() got an unexpected keyword argument 'compose_store'`.

- [ ] **Step 3: Implement**

In `store.py`, extend the ctor and add `family()`:

```python
FAMILIES = ("slots@1", "composed@1")


class MathStore:
    def __init__(self, db, on_change=None, compose_store=None, gdd_store=None):
        self._docs = db["slot_models"]
        self._legacy_tuner_jobs = db["tuner_jobs"]  # migration source only
        self._on_change = on_change
        self._compose = compose_store
        self._gdd = gdd_store
        self._indexed = False

    async def family(self, game_id: str) -> str:
        """The math descriptor (spec §1). GDD intent wins; else which artifact
        doc exists (composed checked first — legacy panes may have auto-seeded
        a stray slots doc for a composed game); else slots."""
        # ponytail: 2-3 lookups per call, no cache — replay DBs are small and
        # correctness beats staleness here.
        if self._gdd is not None:
            doc = await self._gdd.get_doc(game_id, "math-model")
            fam = (getattr(doc, "data", None) or {}).get("game_family") if doc else None
            if fam in FAMILIES:
                return fam
        if self._compose is not None and await self._compose.get(game_id) is not None:
            return "composed@1"
        return "slots@1"
```

In `rest.py` add:

```python
@router.get("/games/{game_id}/math/descriptor")
async def get_math_descriptor(game_id: str, request: Request) -> dict:
    return {"family": await request.app.state.math_store.family(game_id)}
```

In `main.py`: `MathStore` is constructed (line ~118) _before_ `compose_store` (line ~131). Move the `MathStore(...)` construction to after `compose_store` exists and pass `compose_store=compose_store, gdd_store=gdd_store`. `_on_slot_model_change` doesn't reference `compose_store`, so only the constructor call moves — keep `math_hub`/`ToolFactory` wiring order intact.

- [ ] **Step 4: Run tests**

Run: `uv --directory studio/backend run pytest tests/test_math_descriptor.py -q` → PASS.
Run the full backend suite: `uv --directory studio/backend run pytest -q` → no regressions.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/math/store.py studio/backend/app/math/rest.py studio/backend/app/main.py studio/backend/tests/test_math_descriptor.py
git commit -m "feat(math): family descriptor on MathStore + GET /math/descriptor"
```

---

### Task 2: Backend — fold math fields onto game_definitions; MathStore family dispatch

**Files:**

- Modify: `studio/backend/app/compose/models.py` (folded fields, slim wire)
- Modify: `studio/backend/app/math/store.py` (composed read/write dispatch)
- Test: `studio/backend/tests/test_math_store_composed.py` (create)

**Interfaces:**

- Consumes: `MathStore.family` (Task 1), `ComposeStore.put(game_id, *, definition=None, presentation=None, source="api")`.
- Produces: for a composed game, `MathStore.get / get_or_seed / put / save_result / save_tune_result / set_stale_flags` operate on the `game_definitions` doc and return a `SlotModelDoc` **view** whose `model` is the GameDefinition dict. Every existing consumer (hub, REST, agent tools) works unchanged. `GameDefinitionDoc` gains: `params: CurationParams`, `tuner_params: TuningParams`, `locks: SectionLocks`, `result: CurationResult | None`, `tune_result: TuneResult | None`, `verdict_stale: bool` (all defaulted so existing docs validate). `compose_wire` excludes `tune_result` (it embeds the full GA trace; the `/tuner` wire carries it — mirrors `sim_wire`).

**Key rule:** definition writes go through `ComposeStore.put(source=...)` so `game_definition_changed`, scene sync, and auto-build fire; folded math fields are `$set` directly on the `game_definitions` collection (disjoint fields, two writers, one collection — documented in a comment).

- [ ] **Step 1: Write the failing tests**

```python
# studio/backend/tests/test_math_store_composed.py
"""MathStore family dispatch onto game_definitions (spec §2)."""
import pytest

from app.compose.store import ComposeStore
from app.math.models import CurationParams, CurationResult, MetricsWire, TuneResult, default_params
from app.math.store import MathStore


def _metrics():
    return MetricsWire(rtp=0.96, volatility=2.0, hit_frequency=0.3,
                       base_rtp=0.8, feature_rtp=0.16, bonus_hit_rates=[])


@pytest.fixture
def stores(mongo_db):
    compose = ComposeStore(mongo_db)
    math = MathStore(mongo_db, compose_store=compose, gdd_store=None)
    return math, compose


@pytest.mark.asyncio
async def test_composed_get_returns_definition_as_model(stores):
    math, compose = stores
    await compose.get_or_seed("g1")  # composed game exists
    doc = await math.get_or_seed("g1")
    assert doc.model.get("family") == "composed@1"
    assert doc.params == default_params()  # folded defaults appear lazily


@pytest.mark.asyncio
async def test_composed_put_params_persists_without_definition_change(stores):
    math, compose = stores
    await compose.get_or_seed("g1")
    before = (await compose.get("g1")).updated_at
    params = default_params().model_copy(update={"rtp_tolerance": 0.05})
    doc = await math.put("g1", params=params)
    assert doc.params.rtp_tolerance == 0.05
    assert (await compose.get("g1")).definition.get("family") == "composed@1"


@pytest.mark.asyncio
async def test_composed_put_model_routes_through_compose_store(stores, mongo_db):
    math, _ = stores
    events = []

    async def on_change(doc, source):
        events.append((doc.game_id, source))

    compose = ComposeStore(mongo_db, on_change=on_change)
    math = MathStore(mongo_db, compose_store=compose, gdd_store=None)
    await compose.get_or_seed("g1")
    events.clear()
    tuned = {"family": "composed@1", "mechanics": [], "states": [], "start": "base", "transitions": []}
    doc = await math.put("g1", model=tuned, source="tuner")
    assert doc.model == tuned
    assert events == [("g1", "tuner")]  # watermark/scene-sync/auto-build path fired


@pytest.mark.asyncio
async def test_composed_save_results_round_trip(stores):
    math, compose = stores
    await compose.get_or_seed("g1")
    cur = CurationResult(status="pass", metrics=_metrics(), realized_rtp=0.96,
                         pool_size=100, failure=None, ran_at="t0")
    doc = await math.save_result("g1", cur)
    assert doc.result.status == "pass" and doc.verdict_stale is False
    tune = TuneResult(status="pass", verdict="pass", tuned_model={"family": "composed@1"},
                      metrics=_metrics(), ran_at="t1")
    doc = await math.save_tune_result("g1", tune)
    assert doc.tune_result.tuned_model == {"family": "composed@1"}


@pytest.mark.asyncio
async def test_slots_path_unchanged(stores):
    math, _ = stores
    doc = await math.get_or_seed("slots-game")  # no composed doc → slots
    assert "reels" in doc.model  # slots default template
```

- [ ] **Step 2: Run to verify failure**

Run: `uv --directory studio/backend run pytest tests/test_math_store_composed.py -q`
Expected: FAIL — composed get returns the slots default template (no dispatch yet).

- [ ] **Step 3: Implement**

`app/compose/models.py`:

```python
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from app.math.models import (
    CurationParams, CurationResult, SectionLocks, TuneResult, TuningParams,
    default_params, default_tuning_params,
)


class _WireModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class GameDefinitionDoc(_WireModel):
    id: str
    game_id: str
    definition: dict  # composed@1 GameDefinition, Rust serde wire shape (opaque here)
    presentation: dict = {}  # runtime presentation blob, embedded verbatim at build
    # Folded math fields (spec §2 — no third collection). Same names/shapes as
    # SlotModelDoc so MathStore can present one view for both families.
    params: CurationParams = Field(default_factory=default_params)
    tuner_params: TuningParams = Field(default_factory=default_tuning_params)
    locks: SectionLocks = Field(default_factory=SectionLocks)
    result: CurationResult | None = None
    tune_result: TuneResult | None = None
    verdict_stale: bool = False
    created_at: str
    updated_at: str


def compose_wire(doc: GameDefinitionDoc) -> dict:
    # tune_result embeds the full GA trace + profile; the /tuner wire carries it
    # (tuner_view). Keep this wire slim — mirrors sim_wire.
    return doc.model_dump(by_alias=True, mode="json", exclude={"tune_result"})
```

`app/math/store.py` — add a composed branch to each accessor. Shape:

```python
def _composed_view(self, cdoc) -> SlotModelDoc:
    """Present a GameDefinitionDoc as the SlotModelDoc-shaped view every math
    consumer already speaks: model IS the artifact (the definition carries
    family='composed@1', which the Rust binaries sniff)."""
    return SlotModelDoc(
        id=cdoc.id, game_id=cdoc.game_id, model=cdoc.definition,
        params=cdoc.params, tuner_params=cdoc.tuner_params, locks=cdoc.locks,
        presentation=cdoc.presentation, origin="template", touched=True,
        verdict_stale=cdoc.verdict_stale, shape_stale=False,
        result=cdoc.result, tune_result=cdoc.tune_result,
        created_at=cdoc.created_at, updated_at=cdoc.updated_at,
    )
```

Then, in each public method, dispatch first:

```python
async def get(self, game_id: str) -> SlotModelDoc | None:
    if await self.family(game_id) == "composed@1":
        cdoc = await self._compose.get(game_id)
        return self._composed_view(cdoc) if cdoc else None
    ...existing slots body...

async def get_or_seed(self, game_id: str) -> SlotModelDoc:
    if await self.family(game_id) == "composed@1":
        return self._composed_view(await self._compose.get_or_seed(game_id))
    ...existing slots body...
```

`put` composed branch (before the slots body). Folded fields `$set` directly on the collection; definition/presentation delegate to `ComposeStore.put` (single change path — never both a direct `$set` of `definition` and a compose put):

```python
async def put(self, game_id, *, model=None, params=None, tuner_params=None,
              locks=None, presentation=None, source="api") -> SlotModelDoc:
    if await self.family(game_id) == "composed@1":
        await self._compose.get_or_seed(game_id)
        fields: dict = {}
        if params is not None:
            fields["params"] = params.model_dump(mode="json")
        if tuner_params is not None:
            fields["tuner_params"] = tuner_params.model_dump(mode="json")
        if locks is not None:
            fields["locks"] = locks.model_dump(mode="json")
        if fields:
            # ponytail: folded math fields are $set here, definition writes go
            # through ComposeStore.put — two writers, one collection, disjoint
            # fields by construction.
            fields["updated_at"] = _now()
            await self._compose._docs.update_one({"game_id": game_id}, {"$set": fields})
        if model is not None or presentation is not None:
            await self._compose.put(game_id, definition=model,
                                    presentation=presentation, source=source)
        return await self.get(game_id)
    ...existing slots body...
```

`save_result` / `save_tune_result` / `set_stale_flags` composed branches: `$set` `result` / `tune_result` / staleness (+ `verdict_stale: False` on saves, `updated_at`) on `self._compose._docs`, return `await self.get(game_id)`. No `on_change` for pure math-field writes.

`save_realized` gets a composed guard that raises `RuntimeError("composed realize arrives with SP-D")` — nothing calls it for composed until the REST guard (Task 5) exists, this is belt-and-braces.

- [ ] **Step 4: Run tests**

`uv --directory studio/backend run pytest tests/test_math_store_composed.py tests/test_math_descriptor.py -q` → PASS, then the full suite → no regressions (compose tests validate `GameDefinitionDoc` defaults on existing docs).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/compose/models.py studio/backend/app/math/store.py studio/backend/tests/test_math_store_composed.py
git commit -m "feat(math): fold math fields onto game_definitions; MathStore family dispatch"
```

---

### Task 3: Backend — parsers catch up to the Rust wire (family, maxWin, stateRtp, stateVisitFreq)

**Files:**

- Modify: `studio/backend/app/math/models.py` (MetricsWire + MathRunDoc + TuneResult)
- Modify: `studio/backend/app/math/runners/curate.py:27-42` (`parse_result_line`)
- Modify: `studio/backend/app/math/runners/tune.py:86-107` (`parse_tune_result_line`)
- Modify: `studio/backend/app/math/hub.py:340-360` (`record_run` stamps family)
- Test: extend `studio/backend/tests/test_curation_runner.py` and `studio/backend/tests/test_tuner_runner.py` (or wherever `parse_result_line`/`parse_tune_result_line` are covered — grep first, add cases beside the existing ones)

**Interfaces:**

- Produces: `MetricsWire` gains `max_win: float | None = None`, `state_rtp: dict[str, float] | None = None`, `state_visit_freq: dict[str, float] | None = None` (auto-camel: `maxWin`, `stateRtp`, `stateVisitFreq` — exactly the Rust keys). `TuneResult.family: str | None = None`, `MathRunDoc.family: str | None = None` (None on legacy rows/cassettes). `MathHub.record_run(..., family: str | None = None)`.

- [ ] **Step 1: Write the failing tests**

Add beside the existing parse tests (adjust file names to where those live):

```python
def test_parse_result_line_reads_state_fields():
    line = json.dumps({
        "type": "result", "status": "pass", "rtp": 0.96, "volatility": 2.0,
        "hitFrequency": 0.3, "baseRtp": 0.8, "featureRtp": 0.16,
        "bonusHitRates": [], "maxWin": 120.0,
        "stateRtp": {"base": 0.8, "fs1": 0.16},
        "stateVisitFreq": {"base": 1.0, "fs1": 0.01},
        "realizedRtp": 0.96, "poolSize": 100,
    })
    r = parse_result_line(line, ran_at="t")
    assert r.metrics.max_win == 120.0
    assert r.metrics.state_rtp == {"base": 0.8, "fs1": 0.16}
    assert r.metrics.state_visit_freq == {"base": 1.0, "fs1": 0.01}


def test_parse_result_line_without_state_fields_stays_none():
    # legacy cassette lines predate SP-A
    line = json.dumps({
        "type": "result", "status": "pass", "rtp": 0.96, "volatility": 2.0,
        "hitFrequency": 0.3, "baseRtp": 0.8, "featureRtp": 0.16,
        "bonusHitRates": [], "realizedRtp": 0.96, "poolSize": 100,
    })
    r = parse_result_line(line, ran_at="t")
    assert r.metrics.max_win is None
    assert r.metrics.state_rtp is None
    assert r.metrics.state_visit_freq is None
```

And for the tune parser: same two cases on the `metrics` sub-object plus `"family": "composed@1"` top-level → `result.family == "composed@1"`, absent → `None`.

- [ ] **Step 2: Run to verify failure** — pytest, expect `ValidationError`/`AttributeError` (fields don't exist).

- [ ] **Step 3: Implement**

`models.py` `MetricsWire` additions:

```python
class MetricsWire(_WireModel):
    rtp: float
    volatility: float
    hit_frequency: float
    base_rtp: float
    feature_rtp: float
    bonus_hit_rates: list[float]
    se: MetricSEWire | None = None
    # SP-A/SP-B wire additions (None on results that predate them / slots-only paths)
    max_win: float | None = None
    state_rtp: dict[str, float] | None = None
    state_visit_freq: dict[str, float] | None = None
```

`TuneResult` gains `family: str | None = None`; `MathRunDoc` gains `family: str | None = None`.

`parse_result_line` metrics construction adds:

```python
        max_win=d.get("maxWin"), state_rtp=d.get("stateRtp"),
        state_visit_freq=d.get("stateVisitFreq"),
```

`parse_tune_result_line` adds the same three from `m.get(...)` and `family=d.get("family")` to the `TuneResult(...)` call.

`hub.py record_run` signature gains `family: str | None = None`, stamps `family=family` on `MathRunDoc`; the call site in `_generate_reserved` passes `family=(doc0.model or {}).get("family") or "slots@1"` — sniffed from the artifact, no extra lookups.

- [ ] **Step 4: Run tests** — targeted then full backend suite; PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/math/models.py studio/backend/app/math/runners/curate.py studio/backend/app/math/runners/tune.py studio/backend/app/math/hub.py studio/backend/tests/
git commit -m "feat(math): parse family/maxWin/stateRtp/stateVisitFreq from the Rust wire"
```

---

### Task 4: Backend — family-aware derive_target + derive_bounds (artifact-sniffed)

**Files:**

- Modify: `studio/backend/app/math/target_flow.py` (composed branch)
- Modify: `studio/backend/app/math/bounds.py` (`derive_bounds` composed branch)
- Test: `studio/backend/tests/test_targets.py` / `studio/backend/tests/test_bounds.py` (extend the existing files — grep for their names first)

**Interfaces:**

- Consumes: composed artifact shape — `definition["mechanics"][i]` with `type == "reels@1"` carries `config.paytable.entries` (same entry shape as slots: `{symbol, count, payout}`); see `runtime/server/demo/composed.definition.json`.
- Produces: `_is_composed(model: dict) -> bool` helper (`model.get("family") == "composed@1"`), exported from `target_flow.py`. `derive_target_for(gdd_store, game_id, doc)` — signature unchanged — sniffs the doc's model: composed ⇒ `num_bonuses=0` and **no pay constraints** (composed `validate_constraints` rejects non-empty `bonus_hit_rate_bands`, and pay-constraint symbol join keys arrive with SP-D's realizer). `derive_bounds(model)` — signature unchanged — composed ⇒ reads the first `reels@1` mechanic's paytable.

- [ ] **Step 1: Write the failing tests**

```python
COMPOSED_DEF = {
    "family": "composed@1",
    "mechanics": [{"id": "main_reels", "type": "reels@1", "config": {
        "paytable": {"entries": [{"symbol": 0, "count": 3, "payout": 50}]}}}],
    "states": [], "start": "base", "transitions": [],
}


@pytest.mark.asyncio
async def test_composed_target_has_no_bonus_bands_or_pay_constraints():
    # GDD carries full slots-ish intent incl. bonus_hit_rate + pay constraints;
    # composed must ignore both (validate_constraints rejects them until SP-D).
    gdd = _FakeGddStore({
        "math-model": {"rtp": 0.96, "volatility": "low", "bonus_hit_rate": "1:100"},
        "paytable": {"pay_constraints": [{"symbol": "high1", "relation": "floor", "value": 5}]},
        "symbols-reels": {"symbols": [{"slot": "high1", "model_id": 0}]},
        "bonus-features": {"features": [{"name": "fs"}]},
    })
    doc = SimpleNamespace(model=COMPOSED_DEF, params=default_params())
    target = await derive_target_for(gdd, "g1", doc)
    assert target["bonus_hit_rate_bands"] == []
    assert "pay_constraints" not in target
    assert target["rtp_target"] == 0.96


def test_derive_bounds_composed_reads_reels_paytable():
    b = derive_bounds(COMPOSED_DEF)
    assert b["payout_max"] == 200  # max(20, 50*4)
```

(`_FakeGddStore` maps aspect → data; mirror the fake used in the existing target_flow tests.)

- [ ] **Step 2: Run to verify failure** — composed target currently raises `TargetGap` (GDD declares 1 feature, model has 0 bonuses) and `derive_bounds` returns `payout_max == 20`.

- [ ] **Step 3: Implement**

`target_flow.py`:

```python
def _is_composed(model: dict) -> bool:
    return (model or {}).get("family") == "composed@1"


async def derive_target_for(gdd_store, game_id: str, doc) -> dict:
    model = doc.model or {}

    async def data(aspect: str) -> dict:
        d = await gdd_store.get_doc(game_id, aspect)
        return getattr(d, "data", {}) if d is not None else {}

    math_model = await data("math-model")
    if _is_composed(model):
        # Composed targets are the family-agnostic bands only: bonus bands are
        # slots-typed (composed validate_constraints rejects them — #160 owns
        # feature bands) and pay-constraint join keys arrive with SP-D.
        return derive_target(math_model, doc.params, 0)
    num_bonuses = derive_num_bonuses(await data("bonus-features"), model)
    return derive_target(math_model, doc.params, num_bonuses,
                         paytable_data=await data("paytable"),
                         symbols_data=await data("symbols-reels"))
```

`bounds.py`:

```python
def _paytable_entries(model: dict) -> list:
    if (model or {}).get("family") == "composed@1":
        for m in model.get("mechanics") or []:
            if m.get("type") == "reels@1":
                return ((m.get("config") or {}).get("paytable") or {}).get("entries") or []
        return []
    return (model.get("paytable") or {}).get("entries") or []


def derive_bounds(model: dict) -> dict:
    entries = _paytable_entries(model)
    ...rest unchanged...
```

- [ ] **Step 4: Run tests** — targeted + full backend suite → PASS. The generate pipeline for composed now works end to end through the unchanged hub (store dispatch from Task 2 + these two sniffs + Task 3 parsing).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/math/target_flow.py studio/backend/app/math/bounds.py studio/backend/tests/
git commit -m "feat(math): family-aware derive_target + derive_bounds via artifact sniff"
```

---

### Task 5: Backend — composed build target wiring + slots-only route guards

**Files:**

- Modify: `studio/backend/app/math/target_flow.py` (`composed_build_target`)
- Modify: `studio/backend/app/compose/jobs.py` (`build_job` optional target)
- Modify: `studio/backend/app/compose/rest.py:59-71` (build endpoint derives target)
- Modify: `studio/backend/app/compose/autobuild.py` (injected async target provider)
- Modify: `studio/backend/app/main.py` (wire provider into AutoBuilder + build route deps)
- Modify: `studio/backend/app/math/rest.py:50-57,80-91` (realize + apply-template composed guards)
- Test: `studio/backend/tests/test_compose_build_target.py` (create), extend the autobuild/rest compose tests

**Interfaces:**

- Produces: `composed_build_target(gdd_store, math_store, game_id) -> dict | None` (async; None when GDD intent is incomplete → the Rust self-centered default; the verdict already flags `selfDerived`). `build_job(game_id, definition, presentation, settings, target=None)` — when target is not None it lands in the job dict as `"target"`. `AutoBuilder(runner, settings, sio, target_for=None, debounce_s=1.5)` where `target_for: async (game_id) -> dict | None`. Slots-only routes (`POST .../slot-model/realize`, `POST .../slot-model/apply-template`) return **409** with detail `"this is a composed@1 game — the composed realizer arrives with SP-D"` / `"templates are slots@1-only"`.

- [ ] **Step 1: Write the failing tests**

```python
# studio/backend/tests/test_compose_build_target.py
"""composed_build_target + the build-job target ride-along (spec §3)."""
import pytest

from app.compose.jobs import build_job
from app.compose.store import ComposeStore
from app.math.store import MathStore
from app.math.target_flow import composed_build_target


class _FakeGddStore:
    def __init__(self, docs: dict):
        self._docs = docs  # aspect -> data dict

    async def get_doc(self, game_id, aspect):
        if aspect in self._docs:
            data = self._docs[aspect]

            class _Doc:
                pass

            d = _Doc()
            d.data = data
            return d
        return None


@pytest.mark.asyncio
async def test_composed_build_target_derives_from_gdd(mongo_db):
    gdd = _FakeGddStore({"math-model": {"rtp": 0.96, "volatility": "low"}})
    compose = ComposeStore(mongo_db)
    math = MathStore(mongo_db, compose_store=compose, gdd_store=gdd)
    await compose.get_or_seed("g1")
    target = await composed_build_target(gdd, math, "g1")
    assert target["rtp_target"] == 0.96
    assert target["bonus_hit_rate_bands"] == []
    assert "pay_constraints" not in target


@pytest.mark.asyncio
async def test_composed_build_target_none_on_gap(mongo_db):
    gdd = _FakeGddStore({})  # no math-model intent at all
    compose = ComposeStore(mongo_db)
    math = MathStore(mongo_db, compose_store=compose, gdd_store=gdd)
    await compose.get_or_seed("g1")
    assert await composed_build_target(gdd, math, "g1") is None


def test_build_job_carries_target(settings):
    job = build_job("g1", {}, {}, settings, target={"rtp_target": 0.96})
    assert job["target"] == {"rtp_target": 0.96}


def test_build_job_omits_target_when_none(settings):
    assert "target" not in build_job("g1", {}, {}, settings)
```

(`settings`: reuse however the existing `test_compose_*`/autobuild tests obtain a settings object — grep first and mirror.)

Plus an AutoBuilder test (mirror the existing autobuild tests' fake-runner pattern): a scheduled build calls `target_for` and forwards the target into the job the runner receives; `target_for=None` keeps today's job shape. Plus REST guards: `realize` / `apply-template` on a composed game → 409 (use the app-factory test pattern the existing math REST tests use).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

`target_flow.py`:

```python
async def composed_build_target(gdd_store, math_store, game_id: str) -> dict | None:
    """Target for a composed .pkg build: GDD-derived family-agnostic bands when
    the intent is complete, else None → the binary's self-centered default
    (verdict flags selfDerived)."""
    from app.math.targets import TargetGap
    doc = await math_store.get_or_seed(game_id)
    try:
        return await derive_target_for(gdd_store, game_id, doc)
    except TargetGap:
        return None
```

`jobs.py::build_job` gains `target: dict | None = None` and:

```python
    if target is not None:
        job["target"] = target
```

`compose/rest.py` build endpoint, before `build_job`:

```python
    from app.math.target_flow import composed_build_target
    target = await composed_build_target(
        request.app.state.gdd_store, request.app.state.math_store, game_id)
    job = build_job(game_id, doc.definition, doc.presentation,
                    request.app.state.settings, target=target)
```

`autobuild.py`: ctor gains `target_for=None`; in `_run`, before building the job:

```python
            target = await self._target_for(game_id) if self._target_for else None
            res = await self._runner.run(
                build_job(game_id, definition, presentation, self._settings, target=target))
```

`main.py`: `AutoBuilder(compose_runner, settings, sio, target_for=lambda gid: composed_build_target(gdd_store, math_store, gid))` — note `math_store` must exist by then (Task 1 already moved it after `compose_store`; if ordering bites, define the lambda to close over names late — Python closures resolve at call time, so defining the lambda before `math_store = ...` is fine as long as the variable exists before the first build).

`math/rest.py` guards (top of `realize_slot_model_rest` and `apply_slot_model_template`):

```python
    if await request.app.state.math_store.family(game_id) == "composed@1":
        raise HTTPException(status_code=409,
                            detail="this is a composed@1 game — the composed realizer arrives with SP-D")
```

(analogous message for templates).

- [ ] **Step 4: Run tests** — targeted + full backend suite → PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/math/target_flow.py studio/backend/app/compose/jobs.py studio/backend/app/compose/rest.py studio/backend/app/compose/autobuild.py studio/backend/app/main.py studio/backend/app/math/rest.py studio/backend/tests/
git commit -m "feat(compose): derive_target wired into composed builds; slots-only route guards"
```

---

### Task 6: Backend — agent-tool pass: #189 weight_hit_frequency, family-neutral rename, composed report/apply

**Files:**

- Modify: `studio/backend/app/agent_tools.py:1318-1550`
- Modify: `studio/backend/app/math/models.py:8-10` (`TUNER_TOOL_NAMES`)
- Modify: `skills/tune-math.md`
- Modify: `studio/backend/tests/fixtures/replay/run/tuner-chat-tune.json`, `.../tuner-chat-apply.json` (hand-edit tool names)
- Modify: `studio/backend/tests/test_tuner_tools.py`, `test_agent_tools.py`, `test_math_models.py`, `test_skills_load.py` (renames + new cases)
- Test: extend `studio/backend/tests/test_tuner_tools.py`

**Interfaces:**

- Produces: tool names `tune_slot_model` → **`tune_math`**, `apply_tuned_model` → **`apply_tuned_math`** (builders, `_BUILDERS` keys, `TUNER_TOOL_NAMES`, skill frontmatter `tools:` list, interrupt payload `{"tool": "apply_tuned_math", ...}`). `read_tuner_setup` / `set_tuner_params` keep their (already neutral) names. `set_tuner_params` gains `weight_hit_frequency: float | None = None` (validated ≥ 0, written to `weights["hit_frequency"]`) — closes **#189**. `read_tuner_setup` reports a composed-shaped summary for composed games. All "slot model" phrasing in descriptions/reports goes family-neutral ("math model").

- [ ] **Step 1: Write the failing tests**

```python
@pytest.mark.asyncio
async def test_set_tuner_params_accepts_hit_frequency_weight(tool_ctx):
    tool = build_set_tuner_params_tool(tool_ctx)
    out = await tool.coroutine(weight_hit_frequency=2.0)
    doc = await tool_ctx.math_store.get(tool_ctx.game_id)
    assert doc.tuner_params.weights.hit_frequency == 2.0
    assert "hit-freq" in out or "hit_frequency" in out


@pytest.mark.asyncio
async def test_set_tuner_params_rejects_negative_hit_frequency_weight(tool_ctx):
    tool = build_set_tuner_params_tool(tool_ctx)
    out = await tool.coroutine(weight_hit_frequency=-1.0)
    assert "no change made" in out


@pytest.mark.asyncio
async def test_read_tuner_setup_reports_composed_shape(composed_tool_ctx):
    tool = build_read_tuner_setup_tool(composed_tool_ctx)
    out = await tool.coroutine()
    assert "Composed" in out and "states" in out


def test_tuner_tool_names_are_family_neutral():
    assert TUNER_TOOL_NAMES == {
        "read_tuner_setup", "set_tuner_params", "tune_math", "apply_tuned_math"}
```

(`tool_ctx`/`composed_tool_ctx`: mirror how `test_tuner_tools.py` builds its ToolContext today; composed variant seeds a `ComposeStore` doc and a `MathStore` with `compose_store` wired, per Task 2's fixture.)

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

- `set_tuner_params`: add the parameter, extend the weight-validation tuple with `("weight_hit_frequency", weight_hit_frequency)`, add `if weight_hit_frequency is not None: weights["hit_frequency"] = weight_hit_frequency`, extend the report line (`weights rtp/vol/hit/hit-freq …/…/…/{updated.weights.hit_frequency}`) and the description ("…rtp/volatility/hit_rate/hit_frequency fitness weights…").
- Rename `build_tune_slot_model_tool` → `build_tune_math_tool` (tool name `tune_math`), `build_apply_tuned_model_tool` → `build_apply_tuned_math_tool` (tool name `apply_tuned_math`), update `_BUILDERS`. Apply's interrupt label/description: "Apply the tuned math model? This overwrites the current realization." — the store write (`math_store.put(model=tuned, source="tuner")`) already family-dispatches via Task 2, so composed apply routes through `ComposeStore.put` for free — no extra code, but ADD a test asserting the composed apply fires the compose on_change (mirror `test_composed_put_model_routes_through_compose_store`, through the tool).
- `read_tuner_setup`: sniff `_is_composed(model)` (import from `app.math.target_flow`); composed seed-model line:

```python
        if model.get("family") == "composed@1":
            states = model.get("states") or []
            reels = next((m for m in model.get("mechanics") or []
                          if m.get("type") == "reels@1"), {})
            strips = (reels.get("config") or {}).get("strips") or []
            entries = ((reels.get("config") or {}).get("paytable") or {}).get("entries") or []
            meters = [m for m in model.get("mechanics") or [] if m.get("type") == "meter@1"]
            seed_line = (
                f"Composed game: {len(states)} states "
                f"({', '.join(s.get('id', '?') for s in states)}), "
                f"{len(strips)} reel strips, {len(entries)} paytable entries, "
                f"{len(meters)} meter(s).")
```

slots keeps today's line; the target-line `bonus band(s)` clause reads `len(target['bonus_hit_rate_bands'])` for both (0 for composed). Report GA weights incl. hit-frequency.

- `TUNER_TOOL_NAMES` in `models.py`, the `tools:` list + prose in `skills/tune-math.md` ("slot model" → "math model"; keep the skill NAME `tune-math` — already neutral).
- Cassettes: in `tuner-chat-tune.json` / `tuner-chat-apply.json` replace every `tune_slot_model` → `tune_math`, `apply_tuned_model` → `apply_tuned_math` (they're prompt-keyed run cassettes; tool names appear in tool-call steps — text replace, then eyeball the JSON).
- Repo-wide grep to catch stragglers: `grep -rn "tune_slot_model\|apply_tuned_model" --include="*.py" --include="*.md" --include="*.json" --include="*.ts" .` (excluding node_modules/target) — fix every hit **except** `studio/frontend/e2e/*.spec.ts`, which Task 10 owns.

- [ ] **Step 4: Run tests** — full backend suite (`test_skills_load.py` verifies the skill's tools still resolve) → PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/app/math/models.py skills/tune-math.md studio/backend/tests/
git commit -m "feat(agent): family-neutral tuner tools + weight_hit_frequency (#189)"
```

---

### Task 7: Frontend — math pane family-aware load + target strip

**Files:**

- Modify: `studio/frontend/src/plugins/math/restClient.ts` (descriptor + composed doc fetch)
- Modify: `studio/frontend/src/plugins/math/state.ts` (family, composedStateIds, IMetrics additions)
- Modify: `studio/frontend/src/plugins/math/actions.ts` (`openGameMath` branch)
- Modify: `studio/frontend/src/plugins/math/sync.ts` (`refreshDoc` family-aware)
- Modify: `studio/frontend/src/plugins/math/socketClient.ts` (composed change event)
- Modify: `studio/frontend/src/plugins/math/components/TargetStrip.tsx` (bonus-rate slots-only)
- Test: extend `restClient.spec.ts`, `actions.spec.ts`, and the TargetStrip cases in `MathPane.spec.tsx` (or its own spec if one exists — grep)

**Interfaces:**

- Consumes: `GET /games/{id}/math/descriptor` → `{family}`; `GET /games/{id}/game-definition` → post-Task-2 wire `{id, gameId, definition, presentation, params, locks, result, verdictStale, updatedAt}` (camelCase, no tuneResult).
- Produces: `getMathDescriptor(gameId): Promise<{ family: MathFamily }>` and `getComposedMathDoc(gameId): Promise<IComposedMathDocWire>` in the math plugin's own restClient (do NOT import from the game-structure plugin — plugins stay isolated). `type MathFamily = 'slots@1' | 'composed@1'`. `IMathState` gains `family: MathFamily | null` and `composedStateIds: string[]`. `IMetrics` gains `maxWin?: number | null; stateRtp?: Record<string, number> | null; stateVisitFreq?: Record<string, number> | null;`. `ITuneWeights.hitFrequency` already exists.

- [ ] **Step 1: Write the failing tests**

restClient.spec.ts (mirror existing fetch-mock pattern):

```typescript
it('getMathDescriptor hits /math/descriptor', async () => {
  mockFetchJson({ family: 'composed@1' });
  const d = await getMathDescriptor('g1');
  expect(lastFetchUrl()).toContain('/games/g1/math/descriptor');
  expect(d.family).toBe('composed@1');
});

it('getComposedMathDoc reads the game-definition wire', async () => {
  mockFetchJson({
    id: 'x',
    gameId: 'g1',
    definition: { family: 'composed@1', states: [{ id: 'base' }, { id: 'fs1' }] },
    params: FAKE_PARAMS,
    locks: { reels: false, paytable: false, bonus: false },
    result: null,
    verdictStale: false,
    updatedAt: 't',
  });
  const d = await getComposedMathDoc('g1');
  expect(lastFetchUrl()).toContain('/games/g1/game-definition');
});
```

actions.spec.ts: `openGameMath` for a composed descriptor sets `family`, `composedStateIds` (from `definition.states[].id`), `locks`, `curationParams`, `verifyResult`, and does NOT call `getSlotModel`; for slots it behaves exactly as today and sets `family: 'slots@1'`. TargetStrip: renders no `target-bonus-rate` input when `family === 'composed@1'`, still renders RTP + volatility.

- [ ] **Step 2: Run to verify failure** — `npx nx test frontend -- --run src/plugins/math`.

- [ ] **Step 3: Implement**

restClient.ts:

```typescript
export type MathFamily = 'slots@1' | 'composed@1';

export interface IComposedMathDocWire {
  id: string;
  gameId: string;
  definition: { states?: { id: string }[] } & Record<string, unknown>;
  params: ICurationParams;
  locks: ISectionLocks;
  result: ICurationResult | null;
  verdictStale?: boolean;
  updatedAt: string;
}

export async function getMathDescriptor(gameId: string): Promise<{ family: MathFamily }> {
  return okJson(await fetch(`${BACKEND_URL}/games/${gameId}/math/descriptor`));
}

export async function getComposedMathDoc(gameId: string): Promise<IComposedMathDocWire> {
  return okJson(await fetch(`${BACKEND_URL}/games/${gameId}/game-definition`));
}
```

state.ts: add the two fields to `IMathState` + `makeInitialState` (`family: null`, `composedStateIds: []`); add the three optional `IMetrics` fields.

actions.ts `openGameMath` — after the reset/join, fetch the descriptor first, then branch:

```typescript
  const { family } = await getMathDescriptor(gameId);
  if (s.activeGameId.get() !== gameId) return;
  s.family.set(family);
  if (family === 'composed@1') {
    const [doc, tuner, gddDocs, runs] = await Promise.all([getComposedMathDoc(gameId), getTuner(gameId), getGddDocs(gameId), fetchRuns(gameId)]);
    if (s.activeGameId.get() !== gameId) return;
    s.locks.set(doc.locks);
    s.curationParams.set(doc.params);
    s.verifyResult.set(doc.result);
    s.verdictStale.set(!!doc.verdictStale);
    s.composedStateIds.set((doc.definition.states ?? []).map((st) => st.id));
    s.tunerParams.set(tuner.params);
    s.tuneResult.set(tuner.result);
    ...same GDD-fields + runs + refreshTarget tail as the slots branch...
  } else {
    ...existing body...
  }
```

Wrap the whole thing in the existing try/catch. Keep the slots branch byte-identical.

sync.ts `refreshDoc` becomes family-aware (read `s.family.get()`; composed → `getComposedMathDoc`, same field sets, plus refresh `composedStateIds`).

socketClient.ts: alongside the `slot_model_changed` listener, add `game_definition_changed` handled identically (refresh doc + target) but only when `mathSlice().family.get() === 'composed@1'` — a composed write (agent apply, structure edit) must reconcile the open pane.

TargetStrip.tsx: `const family = s.family.get();` and wrap the Bonus-rate `<label>` in `{family !== 'composed@1' && (...)}`.

- [ ] **Step 4: Run gates** — `npx nx test frontend`, `npx nx typecheck frontend` → PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/math/
git commit -m "feat(studio): math pane resolves the family descriptor and loads either artifact"
```

---

### Task 8: Frontend — per-state results, dead-feature warning, target chips (#190), profile state section

**Files:**

- Modify: `studio/frontend/src/plugins/math/components/ResultStrip.tsx`
- Modify: `studio/frontend/src/plugins/math/components/TargetStrip.tsx` (chips row)
- Modify: `studio/frontend/src/plugins/math/tabs/MathProfileTab.tsx` (state-share section)
- Test: extend the ResultStrip/TargetStrip/MathProfileTab specs (grep for where each is covered; `MathPane.spec.tsx` and `reducers.spec.ts` hold most component cases)

**Interfaces:**

- Consumes: `IMetrics.stateRtp` / `stateVisitFreq` / `maxWin` (Task 7), `IMathState.composedStateIds` + `family`, `ITargetSpec.pay_constraints` / `max_win_band` (already typed in state.ts).
- Produces (testids): `state-metrics` (the per-state rows container), `state-row-{id}`, `dead-feature-warning`, `target-chip-max-win`, `target-chip-pay-{i}`, `profile-state-share`.
- Dead-feature rule: family is composed AND `metrics.stateVisitFreq` is present AND some id in `composedStateIds` other than the first (the start state is always visited) has `(stateVisitFreq[id] ?? 0) === 0`. This is exactly the #160 evidence shape (`{"base": 1.0}` — features absent from the map).

- [ ] **Step 1: Write the failing tests**

```typescript
it('renders per-state rows and a dead-feature warning for a composed result', () => {
  seedMathState({
    family: 'composed@1',
    composedStateIds: ['base', 'fs1', 'fs2'],
    // latest outcome carries metrics with stateRtp/stateVisitFreq
    verifyResult: fakeCuration({ stateRtp: { base: 0.9, fs1: 0.06 }, stateVisitFreq: { base: 1.0, fs1: 0.01 } }),
  });
  render(<ResultStrip />);
  expect(screen.getByTestId('state-row-fs1')).toHaveTextContent('fs1');
  expect(screen.getByTestId('dead-feature-warning')).toHaveTextContent('fs2');
});

it('shows no dead-feature warning when every state is visited', () => { ... expect(queryByTestId('dead-feature-warning')).toBeNull(); });

it('renders max-win and pay-constraint chips from the derived target', () => {
  seedMathState({ derivedTarget: { ...baseTarget, max_win_band: { min: 500, max: 1500 }, pay_constraints: [{ symbol: 3, relation: 'floor', count: 5, value: 2 }] } });
  render(<TargetStrip />);
  expect(screen.getByTestId('target-chip-max-win')).toHaveTextContent('500');
  expect(screen.getByTestId('target-chip-pay-0')).toHaveTextContent('floor');
});
```

Follow the existing spec files' render/seed helpers exactly.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

ResultStrip — after the existing metrics `<table>`, when `metrics?.stateRtp` or `metrics?.stateVisitFreq` is present:

```tsx
{
  !running && metrics && (metrics.stateRtp || metrics.stateVisitFreq) && (
    <div data-testid="state-metrics" className="mt-1 text-text-2">
      {Object.keys(metrics.stateRtp ?? metrics.stateVisitFreq ?? {}).map((id) => (
        <span key={id} data-testid={`state-row-${id}`} className="mr-3">
          {id}: RTP share {(metrics.stateRtp?.[id] ?? 0).toFixed(4)} · visits {(metrics.stateVisitFreq?.[id] ?? 0).toFixed(4)}
        </span>
      ))}
    </div>
  );
}
{
  !running && deadStates.length > 0 && (
    <p data-testid="dead-feature-warning" className="mt-1 text-danger">
      Dead feature{deadStates.length > 1 ? 's' : ''}: {deadStates.join(', ')} — never visited in the measured pool. The tuner had no pressure to keep{' '}
      {deadStates.length > 1 ? 'them' : 'it'} alive (#160).
    </p>
  );
}
```

with, above the return:

```tsx
const family = s.family.get();
const composedStateIds = s.composedStateIds.get() as string[];
const visitFreq = metrics?.stateVisitFreq ?? null;
const deadStates = family === 'composed@1' && visitFreq ? composedStateIds.slice(1).filter((id) => (visitFreq[id] ?? 0) === 0) : [];
```

TargetStrip — extend the existing `target-bands` cluster with chips (plain spans in the same `text-text-3` tier; no new colors):

```tsx
{
  target?.max_win_band && (
    <span data-testid="target-chip-max-win" className="text-text-3">
      max win {target.max_win_band.min}–{target.max_win_band.max}x
    </span>
  );
}
{
  (target?.pay_constraints ?? []).map((c, i) => (
    <span key={i} data-testid={`target-chip-pay-${i}`} className="text-text-3">
      {c.relation} s{c.symbol}
      {c.count != null ? `@${c.count}` : ''}
      {c.value != null ? ` ${c.value}x` : ''}
    </span>
  ));
}
```

MathProfileTab — a `profile-state-share` section rendered when `run.metrics?.stateRtp` exists: one row per state with a proportional bar (plain `div` widths off `stateRtp[id] / rtp`, surface/hairline styling per the design language — no chart lib needed for a categorical share) plus the visit frequency as text. Keep it a small pure component in the same file.

- [ ] **Step 4: Run gates** — vitest + typecheck → PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/math/
git commit -m "feat(studio): per-state RTP/visits, dead-feature warning, target chips (#190, #160 evidence)"
```

---

### Task 9: Frontend — game-structure verify verdict strip

**Files:**

- Modify: `studio/frontend/src/plugins/game-structure/restClient.ts` (IComposeVerdict, IBuildResponse.verdict)
- Modify: `studio/frontend/src/plugins/game-structure/socketClient.ts:20-26` (IBuildStatusEvent.verdict)
- Modify: `studio/frontend/src/plugins/game-structure/state.ts:24` (build slice gains verdict)
- Modify: `studio/frontend/src/plugins/game-structure/actions.ts:170-192` (thread verdict)
- Modify: `studio/frontend/src/plugins/game-structure/GameStructurePane.tsx:77-93` (verdict strip replaces gs-metrics)
- Test: extend `GameStructurePane.spec.tsx`, `actions.spec.ts`, `restClient.spec.ts`

**Interfaces:**

- Consumes: backend build response / `game_build_status` event already carry `verdict` (`compose/rest.py:69`, `autobuild.py:56`): `{status: 'pass'|'fail', failure: string|null, realizedRtp: number|null, poolSize: number, rtpTarget: number, rtpTolerance: number, selfDerived: boolean}`.
- Produces: `IComposeVerdict` interface; `build` state shape `{status, metrics, verdict: IComposeVerdict | null, errors}`; testids `gs-verdict` (PASS/FAIL pill), `gs-verdict-rtp`, `gs-verdict-self-derived`, `gs-verdict-failure`. The `gs-metrics`/`gs-metric-*` spans are **deleted** (the stateVisits counts were measured over the 2× candidate population — misleading; the verdict's `realizedRtp` is pool-truth).

- [ ] **Step 1: Write the failing tests**

```typescript
it('build success renders the verify verdict, not raw candidate metrics', async () => {
  mockBuildResponse({ ok: true, errors: [], metrics: FAKE_METRICS, verdict: { status: 'pass', failure: null, realizedRtp: 0.9612, poolSize: 10000, rtpTarget: 0.96, rtpTolerance: 0.01, selfDerived: true }, packageId: 'g1' });
  ...open pane, click gs-build...
  expect(await screen.findByTestId('gs-verdict')).toHaveTextContent('PASS');
  expect(screen.getByTestId('gs-verdict-rtp')).toHaveTextContent('0.961');
  expect(screen.getByTestId('gs-verdict-self-derived')).toHaveTextContent('self-derived');
  expect(screen.queryByTestId('gs-metrics')).toBeNull();
});

it('a fail verdict shows the failure reason', ...);
it('applyBuildStatus forwards the verdict from the auto-build event', ...);
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

restClient.ts:

```typescript
export interface IComposeVerdict {
  status: 'pass' | 'fail';
  failure: string | null;
  realizedRtp: number | null;
  poolSize: number;
  rtpTarget: number;
  rtpTolerance: number;
  selfDerived: boolean;
}

export interface IBuildResponse {
  ok: boolean;
  errors: string[];
  metrics: IComposeMetrics | null;
  verdict: IComposeVerdict | null;
  packageId: string;
}
```

state.ts build slice: `build: { status: ...; metrics: IComposeMetrics | null; verdict: IComposeVerdict | null; errors: string[] }` (+ initial `verdict: null`). actions.ts: every `s.build.set(...)` site gains `verdict` (`res.verdict ?? null` on done, `null` elsewhere); `IBuildStatusEvent` gains `verdict?: IComposeVerdict | null` and `applyBuildStatus` forwards it. Pane strip (replacing the `gs-metrics` block):

```tsx
{
  build.status === 'done' && build.verdict && (
    <span className="flex items-center gap-2 text-[11px]">
      <StatusPill data-testid="gs-verdict" tone={build.verdict.status === 'pass' ? 'success' : 'danger'}>
        {build.verdict.status === 'pass' ? 'PASS' : 'FAIL'}
      </StatusPill>
      {build.verdict.realizedRtp != null && (
        <span data-testid="gs-verdict-rtp" className="text-text-2">
          rtp {build.verdict.realizedRtp.toFixed(3)} (target {build.verdict.rtpTarget.toFixed(2)}±{build.verdict.rtpTolerance})
        </span>
      )}
      {build.verdict.selfDerived && (
        <span data-testid="gs-verdict-self-derived" className="text-text-3" title="No GDD intent — the target was centered on the game's own measured RTP.">
          self-derived
        </span>
      )}
      {build.verdict.failure && (
        <span data-testid="gs-verdict-failure" className="text-danger">
          {build.verdict.failure}
        </span>
      )}
    </span>
  );
}
```

Note a **failed verify** arrives as `ok: false` with a verdict — `buildPackage`'s error branch must still surface the verdict: on `!res.ok`, set `{ status: 'error', metrics: null, verdict: res.verdict ?? null, errors: res.errors ?? ['build failed'] }` and render the verdict block for `status === 'error'` too (adjust the condition to `build.verdict && (build.status === 'done' || build.status === 'error')`).

- [ ] **Step 4: Run gates** — vitest + typecheck → PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/game-structure/
git commit -m "feat(studio): game-structure build strip shows the verify verdict"
```

---

### Task 10: E2e — composed math flow, verdict strip, tool renames; full suite

**Files:**

- Create: `studio/frontend/e2e/composed-math.spec.ts`
- Modify: `studio/frontend/e2e/game-structure.spec.ts:68-69` (gs-metrics → gs-verdict)
- Modify: `studio/frontend/e2e/tuner-chat.spec.ts`, `studio/frontend/e2e/pay-constraints.spec.ts` (tool renames)

**Interfaces:**

- Consumes: everything above, live. Playwright suite runs against the replay backend on **:8002** (worktree offset 2 — export `BLOOM_PORT_OFFSET=2`, start `just backend-serve-replay` first). Tune/curate subprocesses are the real seed-deterministic binaries — prebuild for speed: `cargo build --release -p bloom-simulator -p bloom-tuner`.

- [ ] **Step 1: Write `composed-math.spec.ts`**

Follow `math-plugin.spec.ts`'s `setupGame`/pane-opening helpers verbatim, with a composed twist: seed via `PUT /games/{gameId}/game-definition` instead of `/slot-model`. Use the demo definition (copy the JSON from `runtime/server/demo/composed.definition.json` into the spec as `COMPOSED_DEF`) and a features-dead variant `DEAD_DEF` (same JSON with every `9` removed from `strips` and the `events` array emptied — scatters can never fire, the meter's `count_symbol` never lands, so `fs1`/`fs2` are unreachable). Give curation forgiving params so verdicts are RTP-stable: `PUT /games/{id}/slot-model` with `{ params: { poolSize: 500, candidateCount: 20000, masterSeed: 2026, rtpTolerance: 0.5, realizedCorrectionBand: 0.05, bonusRateTolerance: 0.25 } }` (family-dispatched onto the composed doc), GDD intent `{ rtp: '96%', volatility: 'low' }` — with rtpTolerance 0.5 and the `low` band being volatility 0–3, assert _presence_ of results, not a specific verdict, except where deterministic.

Scenarios:

1. **descriptor + strip shape** — open the Math pane on a composed game: `target-rtp` and `target-volatility` render, `target-bonus-rate` does NOT (`expect(page.getByTestId('target-bonus-rate')).toHaveCount(0)`).
2. **verify surfaces per-state rows** — click the Verify control (same testid the math-plugin spec uses), wait for the result strip; `state-row-base` visible; with `COMPOSED_DEF` also `state-row-fs1`; no `dead-feature-warning`.
3. **dead features are called out** — seed `DEAD_DEF`, verify, expect `dead-feature-warning` to contain `fs1` and `fs2` (deterministic: the states are structurally unreachable).
4. **slots regression guard** — open a slots game's math pane (reuse `MODEL_09` seeding from math-plugin.spec.ts) and assert `target-bonus-rate` IS present and no `state-metrics` block renders.

Skip a full composed _tune_ scenario in e2e — the generate pipeline is exercised by the backend suite and a composed GA run is minutes-long; the wire from tune → pane is identical to slots (same events, same strips), which spec 4 already covers. `// ponytail: composed tune e2e deferred — add if the composed genome wire ever diverges from slots in the pane.`

- [ ] **Step 2: Update `game-structure.spec.ts`**

The build assertion (`:68-69`) becomes:

```typescript
await expect(page.getByTestId('gs-verdict')).toBeVisible({ timeout: 300_000 }); // 10k-seed build + possible compile
await expect(page.getByTestId('gs-verdict-rtp')).toContainText('rtp');
```

Grep the file for other `gs-metric` references and update.

- [ ] **Step 3: Update tool-name references**

In `tuner-chat.spec.ts` and `pay-constraints.spec.ts` replace `tune_slot_model` → `tune_math`, `apply_tuned_model` → `apply_tuned_math` (they appear in run-step assertions keyed to the backend cassettes updated in Task 6 — the names must match those cassettes exactly).

- [ ] **Step 4: Run the new spec, then the full suite**

```bash
cd studio/frontend
$env:BLOOM_PORT_OFFSET = '2'
npx playwright test e2e/composed-math.spec.ts e2e/game-structure.spec.ts e2e/tuner-chat.spec.ts e2e/pay-constraints.spec.ts
```

Expected: PASS. Then the whole thing from the worktree root: `just e2e` → every spec green (contention-flaked specs get a solo re-run before being judged red, per repo memory).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/e2e/
git commit -m "test(e2e): composed math pane flow + verdict strip + neutral tool names"
```

---

### Task 11: Whole-branch verification + PR

- [ ] **Step 1: All gates, in order**

```bash
uv --directory studio/backend run pytest -q
cd studio/frontend && node_modules/.bin/prettier --check . && npx nx typecheck frontend && npx nx test frontend && npx nx build frontend
cargo test --workspace   # nothing Rust changed — regression guard only
just e2e                 # BLOOM_PORT_OFFSET=2, replay backend on :8002
```

- [ ] **Step 2: Push + PR**

```bash
git push -u origin feat/sp-c-family-dispatch
gh pr create --title "feat(math): SP-C backend+studio family dispatch (#164)" --body "..."
```

PR body: summary per spec section; note the ride-alongs (#189 closed, #190 closed, #160 evidence surfaced — reference the issues); note the `gs-metrics` → `gs-verdict` testid change and the tool renames (cassettes updated); follow-ups discovered along the way get filed as issues.

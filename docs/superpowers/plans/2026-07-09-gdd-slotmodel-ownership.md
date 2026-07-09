# GDD/SlotModel Ownership Rework — Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the GDD the single owner of design intent and the SlotModel the single owner of realization — schema eviction, birth + gated sectional re-realization via `realize_slot_model`, a `model_id` join key, read-only mirrors in the GDD viewer, and staleness flags.

**Architecture:** The GDD schema loses its realization-grade fields and gains `pay_constraints` (compiled by Plan 2) and a machine-managed `model_id` join column. A new `app/math/shape.py` module (structural sibling of `app/scene/intent_rebuild.py`) detects shape edits and runs birth/sectional realization, honoring `SectionLocks` and gated by the existing `interrupt()` approval pattern when the model is `touched`. Staleness flags live on `SlotModelDoc` and surface as badges.

**Tech Stack:** Python/FastAPI/Motor (studio backend), pytest(-asyncio), React + hookstate + vitest (studio frontend), Playwright e2e. No Rust changes in this plan (that is Plan 2).

**Spec:** `docs/superpowers/specs/2026-07-09-gdd-slotmodel-source-of-truth-design.md`

## Global Constraints

- Work on branch `feat/gdd-slotmodel-sot` in worktree `C:\code\bloom.wt\gdd-slotmodel-sot` (BLOOM_PORT_OFFSET=1 → backend :8001, frontend :4201, engine :4301). Never use default ports.
- Semantic commits (`feat(gdd): …`, `test: …`); TDD every task: failing test → minimal code → pass → commit.
- Backend tests: `uv --directory studio/backend run pytest tests/ -q` (run from the worktree root).
- Frontend gates before any push: `node_modules/.bin/prettier --check .`, `npx nx run-many -t typecheck test build` (vitest green ≠ types valid — always run all).
- TypeScript interfaces use an `I` prefix. Studio UI follows `docs/design-language.md`; no raw colors outside `styles.css`.
- Playwright e2e (`just e2e` with `just backend-serve-replay` on :8001) before the PR; it is not in CI.
- The evicted GDD fields are `paytable.payouts`, `paytable.special_pays`, `bonus-features.free_spins`, `math-model.payline_overrides`, `math-model.bet_range` — exactly these, nothing else.
- Shape fields (trigger re-realization): `math-model.{reels,rows,payline_mode,payline_count}`, `symbols-reels.{symbols,strip_length}`, `bonus-features.features`.
- Target fields (set `verdict_stale` when edited after a result exists): `math-model.{rtp,volatility,bonus_hit_rate,max_win,hit_frequency}`.

---

### Task 1: GDD schema rework — evict realization fields, add `pay_constraints` and `model_id`

**Files:**

- Modify: `studio/backend/app/gdd/schemas.py`
- Test: `studio/backend/tests/test_gdd_schemas.py` (create; there is a `tests/test_gdd_store.py` you may consult for store test style)

**Interfaces:**

- Produces: `ASPECT_SCHEMAS` without the five evicted fields; `paytable` gains `Field("pay_constraints", "Pay constraints", "table", "param", columns=(symbol, relation[top-paying|floor|ceiling], count, value))`; `symbols-reels.symbols` table gains a `model_id` column. Everything downstream (`field_catalog`, `set_fields` validation, `render`) picks this up automatically.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_gdd_schemas.py
from app.gdd.schemas import ASPECT_SCHEMAS, field_catalog


def _keys(aspect):
    return [f.key for f in ASPECT_SCHEMAS[aspect]]


def test_evicted_fields_gone():
    assert "payouts" not in _keys("paytable")
    assert "special_pays" not in _keys("paytable")
    assert "free_spins" not in _keys("bonus-features")
    assert "payline_overrides" not in _keys("math-model")
    assert "bet_range" not in _keys("math-model")


def test_pay_constraints_field():
    field = next(f for f in ASPECT_SCHEMAS["paytable"] if f.key == "pay_constraints")
    assert field.type == "table"
    assert field.required is False
    cols = {c.key: c for c in field.columns}
    assert set(cols) == {"symbol", "relation", "count", "value"}
    assert cols["relation"].enum == ("top-paying", "floor", "ceiling")


def test_symbols_table_has_model_id_column():
    field = next(f for f in ASPECT_SCHEMAS["symbols-reels"] if f.key == "symbols")
    assert "model_id" in {c.key for c in field.columns}


def test_paytable_no_longer_required():
    # payouts was the only required paytable field; after eviction the aspect
    # has no required params (derive_status: data present -> drafted).
    assert not [f for f in ASPECT_SCHEMAS["paytable"] if f.required]


def test_catalog_reflects_schema():
    cat = field_catalog()
    assert "pay_constraints" in [f["key"] for f in cat["paytable"]]
    assert "payouts" not in [f["key"] for f in cat["paytable"]]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_gdd_schemas.py -q`
Expected: FAIL (`payouts` still present, `pay_constraints` missing).

- [ ] **Step 3: Edit `ASPECT_SCHEMAS`**

In `studio/backend/app/gdd/schemas.py`:

Remove from `"math-model"` the two lines:

```python
        Field("payline_overrides", "Payline overrides", "list", "param"),
        Field("bet_range", "Bet range", "text", "param"),
```

Change the `"symbols-reels"` `symbols` field to include the machine-managed join column:

```python
        Field("symbols", "Symbols", "table", "param", required=True,
              columns=_t(("slot", "Slot"), ("name", "Name"),
                         ("kind", "Kind",
                          ("high", "low", "wild", "scatter", "bonus")),
                         ("art_desc", "Art description"),
                         ("model_id", "Model id")),
              help="model_id is machine-managed: written back by realization; "
                   "do not set it by hand."),
```

Replace the whole `"paytable"` list with:

```python
    "paytable": [
        Field("pay_constraints", "Pay constraints", "table", "param",
              columns=_t(("symbol", "Symbol"),
                         ("relation", "Relation",
                          ("top-paying", "floor", "ceiling")),
                         ("count", "Count"), ("value", "Value (x bet)")),
              help="Design constraints the tuner must honor (compiled in Plan 2). "
                   "Actual payouts are realized by the GA and mirrored read-only."),
        Field("notes", "Notes", "text", "narrative"),
    ],
```

Replace the whole `"bonus-features"` list with:

```python
    "bonus-features": [
        Field("features", "Features", "table", "param", required=True,
              columns=_t(("name", "Name"), ("trigger", "Trigger"),
                         ("description", "Description"))),
        Field("bonus_buy", "Bonus buy", "text", "param"),
    ],
```

- [ ] **Step 4: Run tests to verify they pass, and run the full backend suite**

Run: `uv --directory studio/backend run pytest tests/test_gdd_schemas.py tests/ -q`
Expected: new tests PASS. Some existing tests referencing evicted fields (e.g. GDD render/store/router tests using `payouts` or `free_spins`) may now FAIL — update those tests to use surviving fields (`pay_constraints` rows, `features` rows) so they test the same behavior against the new schema. Do not weaken assertions; substitute fields.

- [ ] **Step 5: Commit**

```bash
git add -A studio/backend
git commit -m "feat(gdd): evict realization fields, add pay_constraints and model_id join column"
```

---

### Task 2: SlotModelDoc provenance + staleness fields, `touched` stamping, legacy backfill

**Files:**

- Modify: `studio/backend/app/math/models.py` (SlotModelDoc, around line 208)
- Modify: `studio/backend/app/math/store.py` (get, put, new set_stale_flags/save_realized)
- Test: `studio/backend/tests/test_math_store.py` (extend the existing file)

**Interfaces:**

- Produces on `SlotModelDoc`: `origin: Literal["template", "realized"] = "template"`, `touched: bool = False`, `verdict_stale: bool = False`, `shape_stale: bool = False` (wire names via the existing camel alias generator: `origin`, `touched`, `verdictStale`, `shapeStale`).
- Produces on `MathStore`:
  - `put(...)` stamps `touched=True` for `source` values other than `"realize"`.
  - `async def save_realized(self, game_id: str, model: dict) -> SlotModelDoc` — writes model with `origin="realized"`, `touched=False` preserved semantics (does NOT set touched), clears `shape_stale`, sets `verdict_stale=True` when a `result`/`tune_result` exists, fires `_on_change(doc, "realize")`.
  - `async def set_stale_flags(self, game_id: str, *, verdict_stale: bool | None = None, shape_stale: bool | None = None) -> SlotModelDoc` — flag-only write, fires `_on_change(doc, "flags")`.
- Legacy migration: `get()` backfills `touched=True, origin="template"` on docs missing the `touched` key (conservative: pre-existing models get the gate).

- [ ] **Step 1: Write the failing tests**

Append to `studio/backend/tests/test_math_store.py` (match its existing fixture style — it uses an async mongo test db fixture; reuse it):

```python
async def test_put_stamps_touched(store):
    await store.get_or_seed("g1")
    doc = await store.put("g1", model={"rows": 3}, source="api")
    assert doc.touched is True
    assert doc.origin == "template"


async def test_save_realized_sets_origin_and_clears_shape_stale(store):
    await store.get_or_seed("g2")
    await store.set_stale_flags("g2", shape_stale=True)
    doc = await store.save_realized("g2", {"rows": 4})
    assert doc.origin == "realized"
    assert doc.model["rows"] == 4
    assert doc.shape_stale is False


async def test_save_realized_marks_verdict_stale_when_result_exists(store, sample_tune_result):
    await store.get_or_seed("g3")
    await store.save_tune_result("g3", sample_tune_result)
    doc = await store.save_realized("g3", {"rows": 4})
    assert doc.verdict_stale is True


async def test_new_results_clear_verdict_stale(store, sample_tune_result):
    await store.get_or_seed("g4")
    await store.set_stale_flags("g4", verdict_stale=True)
    doc = await store.save_tune_result("g4", sample_tune_result)
    assert doc.verdict_stale is False


async def test_legacy_doc_backfills_touched_true(store):
    # simulate a pre-rework doc: strip the new keys at the raw level
    await store.get_or_seed("g5")
    await store._docs.update_one(
        {"game_id": "g5"},
        {"$unset": {"touched": "", "origin": "", "verdict_stale": "", "shape_stale": ""}},
    )
    doc = await store.get("g5")
    assert doc.touched is True and doc.origin == "template"
```

If the file has no `sample_tune_result` fixture, add one building a minimal `TuneResult(status="pass", ran_at="2026-07-09T00:00:00Z")`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_math_store.py -q`
Expected: FAIL (unknown fields / missing methods).

- [ ] **Step 3: Implement**

In `app/math/models.py`, add to `SlotModelDoc` after `presentation`:

```python
    # provenance + staleness (spec 2026-07-09 §4/§5)
    origin: Literal["template", "realized"] = "template"
    touched: bool = False           # human PUT or tuner apply happened
    verdict_stale: bool = False     # result no longer describes the model/targets
    shape_stale: bool = False       # GDD shape != model (gated re-realize denied)
```

(`Literal` is already imported in that module.)

In `app/math/store.py`:

In `get()`, after the empty-model backfill block, add:

```python
        if "touched" not in raw:
            # Pre-rework doc: conservatively treat as human-shaped so the
            # re-realize gate applies (spec §9 migration).
            legacy = {"touched": True, "origin": "template",
                      "verdict_stale": False, "shape_stale": False}
            await self._docs.update_one({"_id": raw["_id"]}, {"$set": legacy})
            raw = {**raw, **legacy}
```

In `put()`, extend the `fields` dict construction — after `fields: dict = {"updated_at": _now()}` add:

```python
        if source != "realize":
            fields["touched"] = True
```

Add the two new methods after `put()`:

```python
    async def save_realized(self, game_id: str, model: dict) -> SlotModelDoc:
        existing = await self.get_or_seed(game_id)
        fields = {
            "model": model, "origin": "realized", "shape_stale": False,
            "updated_at": _now(),
        }
        if existing.result is not None or existing.tune_result is not None:
            fields["verdict_stale"] = True
        await self._docs.update_one({"game_id": game_id}, {"$set": fields})
        doc = await self.get(game_id)
        if self._on_change is not None:
            await self._on_change(doc, "realize")
        return doc

    async def set_stale_flags(self, game_id: str, *,
                              verdict_stale: bool | None = None,
                              shape_stale: bool | None = None) -> SlotModelDoc:
        await self.get_or_seed(game_id)
        fields: dict = {"updated_at": _now()}
        if verdict_stale is not None:
            fields["verdict_stale"] = verdict_stale
        if shape_stale is not None:
            fields["shape_stale"] = shape_stale
        await self._docs.update_one({"game_id": game_id}, {"$set": fields})
        doc = await self.get(game_id)
        if self._on_change is not None:
            await self._on_change(doc, "flags")
        return doc
```

In `save_result()` and `save_tune_result()`, add `"verdict_stale": False` into each `$set` dict (a fresh measurement always describes the current model).

- [ ] **Step 4: Run tests**

Run: `uv --directory studio/backend run pytest tests/test_math_store.py tests/ -q`
Expected: PASS (full suite too — the new fields are defaulted so existing wire fixtures stay valid).

- [ ] **Step 5: Commit**

```bash
git add -A studio/backend
git commit -m "feat(math): SlotModelDoc provenance/staleness fields with touched stamping and legacy backfill"
```

---

### Task 3: realizer id-stability — `existing_ids`, `slot_ids` output, bonuses from `features`

**Files:**

- Modify: `studio/backend/app/math/realize.py`
- Test: `studio/backend/tests/test_realize.py` (extend)

**Interfaces:**

- Produces: `realize_slot_model(math_model, symbols_reels, paytable, bonus_features, existing_ids: dict[str, int] | None = None) -> RealizeResult` where `RealizeResult` gains `slot_ids: dict[str, int] | None` (lowercased slot → assigned model id; `None` when model is `None`).
- Id assignment: a symbol row whose lowercased `slot` (or `name`) appears in `existing_ids` keeps that id; new rows get sequential ids starting at `max(existing used ids)+1` (or 0). Reels/paytable reference these ids (row index is no longer the id).
- `_realize_bonuses` now reads `bonus_features["features"]` (the surviving table): one `FreeSpins` bonus per row with default config `spins_awarded=10, retrigger=False, multiplier=1` — the GA owns the numbers (Plan 2 spec §6; `free_spins` is evicted).

- [ ] **Step 1: Write the failing tests**

Append to `studio/backend/tests/test_realize.py` (reuse its existing helper style for building GDD dicts):

```python
def _symbols(rows):
    return {"symbols": rows}


def test_existing_ids_preserved_and_new_ids_fresh():
    rows = [
        {"slot": "wild", "name": "Wild", "kind": "wild", "model_id": 3},
        {"slot": "thor", "name": "Thor", "kind": "high"},   # new symbol
    ]
    res = realize_slot_model({}, _symbols(rows), {}, {},
                             existing_ids={"wild": 3})
    assert res.model is not None
    assert res.slot_ids == {"wild": 3, "thor": 4}
    ids = {d["id"] for d in res.model["symbols"]}
    assert ids == {3, 4}
    # reels/paytable must reference the preserved ids, not row indexes
    assert set(sum(res.model["reels"], [])) <= ids


def test_slot_ids_returned_without_existing_ids():
    rows = [{"slot": "a", "kind": "high"}, {"slot": "b", "kind": "low"}]
    res = realize_slot_model({}, _symbols(rows), {}, {})
    assert res.slot_ids == {"a": 0, "b": 1}


def test_bonuses_realized_from_features_table():
    rows = [{"slot": "scat", "kind": "scatter"}, {"slot": "a", "kind": "high"}]
    bonus = {"features": [{"name": "Free Spins", "trigger": "3 scatters",
                           "description": "wheel"}]}
    res = realize_slot_model({}, _symbols(rows), {}, bonus)
    assert len(res.model["bonuses"]) == 1
    fs = res.model["bonuses"][0]["FreeSpins"]
    assert fs["config"]["spins_awarded"] == 10
    assert fs["trigger"]["min_count"] == 3
```

Update any existing tests in this file that build bonuses via `free_spins` rows to use `features` rows instead (same assertion intent).

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_realize.py -q`
Expected: FAIL (`slot_ids` unknown, bonuses empty).

- [ ] **Step 3: Implement**

In `app/math/realize.py`:

`RealizeResult` gains the field:

```python
@dataclass(frozen=True)
class RealizeResult:
    model: dict | None
    errors: list[str]
    warnings: list[str]
    slot_ids: dict[str, int] | None = None
```

Rewrite `_realize_symbols` to honor `existing_ids`:

```python
def _realize_symbols(
    symbols_reels: dict, existing_ids: dict[str, int] | None = None,
) -> tuple[list[dict], dict[str, int], list[str], list[str]]:
    """Build SymbolDef rows + a {slot/name -> id} map. Ids of surviving slots
    are preserved via existing_ids; new slots get fresh sequential ids (spec §5
    join-key stability)."""
    rows = symbols_reels.get("symbols") or []
    existing_ids = existing_ids or {}
    errors: list[str] = []
    warnings: list[str] = []
    defs: list[dict] = []
    name_to_id: dict[str, int] = {}
    used = set(existing_ids.values())
    next_id = max(used, default=-1) + 1
    for i, row in enumerate(rows):
        kind = str(row.get("kind", "")).strip().lower()
        role = _KIND_TO_ROLE.get(kind)
        if role is None:
            role = "normal"
            warnings.append(
                f"symbol row {i} kind '{row.get('kind')}' unknown; role defaulted to normal"
            )
        keys = [str(row.get(k, "")).strip().lower() for k in ("slot", "name")]
        keys = [k for k in keys if k]
        sid = next((existing_ids[k] for k in keys if k in existing_ids), None)
        if sid is None:
            sid = next_id
            next_id += 1
        defs.append({"id": sid, "role": role})
        for k in keys:
            name_to_id[k] = sid
    if not defs:
        errors.append("no symbols defined; cannot realize a model")
    return defs, name_to_id, errors, warnings
```

Rewrite `_realize_bonuses` to read the `features` table:

```python
def _realize_bonuses(
    bonus_features: dict, symbol_defs: list[dict]
) -> tuple[list[dict], list[str], list[str]]:
    """One FreeSpins bonus per GDD features row. The numeric config is a seed
    the GA owns (free_spins was evicted from the GDD — spec §3)."""
    errors: list[str] = []
    warnings: list[str] = []
    rows = bonus_features.get("features") or []
    if not rows:
        return [], errors, warnings
    trigger = next((d["id"] for d in symbol_defs if d["role"] == "scatter"), None)
    if trigger is None:
        warnings.append(
            "bonus features defined but no scatter/bonus trigger symbol exists; "
            "bonuses skipped"
        )
        return [], errors, warnings
    bonuses: list[dict] = []
    for _row in rows:
        bonuses.append({"FreeSpins": {
            "trigger": {"symbol": trigger, "min_count": BONUS_MIN_COUNT},
            "config": {
                "spins_awarded": 10, "retrigger": False,
                "multiplier": 1, "feature_reels": None,
            },
        }})
    return bonuses, errors, warnings
```

In `realize_slot_model`, add the parameter and thread it through; build `slot_ids` from the symbols table's `slot` column and return it:

```python
def realize_slot_model(
    math_model: dict,
    symbols_reels: dict,
    paytable: dict,
    bonus_features: dict,
    existing_ids: dict[str, int] | None = None,
) -> RealizeResult:
```

Change the `_realize_symbols` call to pass `existing_ids`, and every `return RealizeResult(None, errors, warnings)` stays as-is (dataclass default covers `slot_ids`). Before the final return, compute:

```python
    slot_ids = {
        str(row.get("slot", "")).strip().lower(): name_to_id[str(row.get("slot", "")).strip().lower()]
        for row in (symbols_reels.get("symbols") or [])
        if str(row.get("slot", "")).strip()
    }
```

and return `RealizeResult(model, errors, warnings, slot_ids)`.

Note: `_realize_paylines`'s `payline_overrides` branch and `_realize_paytable`'s `payouts` branch stay — they tolerate the now-absent keys and keep the module pure/reusable. Do not remove them in this task.

- [ ] **Step 4: Run tests**

Run: `uv --directory studio/backend run pytest tests/test_realize.py tests/e2e/test_realize_parity.py tests/ -q`
Expected: PASS, including the Rust round-trip parity test (ids are still plain ints; the serde shape is unchanged).

- [ ] **Step 5: Commit**

```bash
git add -A studio/backend
git commit -m "feat(math): realizer id stability via existing_ids and bonuses from features table"
```

---

### Task 4: `app/math/shape.py` — pure shape/target detection and sectional merge

**Files:**

- Create: `studio/backend/app/math/shape.py`
- Test: `studio/backend/tests/test_shape.py`

**Interfaces (pure — no IO in this task):**

- `SHAPE_FIELDS: dict[str, set[str]]`, `TARGET_FIELDS: dict[str, set[str]]` (values per Global Constraints).
- `is_shape_change(aspect: str, fields: dict) -> bool`, `is_target_change(aspect: str, fields: dict) -> bool` — same contract as `intent_rebuild.is_intent_change`.
- `affected_sections(aspect: str, fields: dict) -> set[str]` — subset of `{"symbols","reels","paylines","paytable","bonuses"}`.
- `merge_sections(existing: dict, realized: dict, sections: set[str], locks) -> dict` — copies only the model keys of unlocked affected sections from `realized` onto a copy of `existing`; `locks` is `SectionLocks` (`locks.reels` blocks `reels`+`paylines`, `locks.paytable` blocks `paytable`, `locks.bonus` blocks `bonuses`; `symbols` is never lockable).

- [ ] **Step 1: Write the failing tests**

```python
# studio/backend/tests/test_shape.py
from app.math.models import SectionLocks
from app.math.shape import (
    affected_sections, is_shape_change, is_target_change, merge_sections,
)


def test_shape_and_target_detection():
    assert is_shape_change("math-model", {"reels": 3})
    assert is_shape_change("symbols-reels", {"symbols": []})
    assert is_shape_change("bonus-features", {"features": []})
    assert not is_shape_change("math-model", {"rtp": "96%"})
    assert is_target_change("math-model", {"rtp": "96%"})
    assert is_target_change("math-model", {"max_win": 5000})
    assert not is_target_change("theme", {"name": "x"})


def test_affected_sections():
    assert affected_sections("math-model", {"reels": 3}) == {"reels", "paylines"}
    assert affected_sections("symbols-reels", {"symbols": []}) == {
        "symbols", "reels", "paytable"}
    assert affected_sections("bonus-features", {"features": []}) == {"bonuses"}
    assert affected_sections("math-model", {"rtp": "96%"}) == set()


def test_merge_sections_respects_locks():
    existing = {"symbols": [{"id": 0, "role": "normal"}], "reels": [[0]],
                "rows": 3, "paylines": [[0]],
                "paytable": {"entries": [{"symbol": 0, "count": 3, "payout": 7}]},
                "bonuses": []}
    realized = {"symbols": [{"id": 0, "role": "normal"}, {"id": 1, "role": "wild"}],
                "reels": [[0, 1]], "rows": 4, "paylines": [[0], [1]],
                "paytable": {"entries": [{"symbol": 1, "count": 3, "payout": 1}]},
                "bonuses": [{"FreeSpins": {}}]}
    out = merge_sections(existing, realized,
                         {"symbols", "reels", "paytable", "bonuses"},
                         SectionLocks(paytable=True))
    assert out["symbols"] == realized["symbols"]          # never lockable
    assert out["reels"] == realized["reels"] and out["rows"] == 4
    assert out["paytable"] == existing["paytable"]        # locked
    assert out["bonuses"] == realized["bonuses"]
    assert out["paylines"] == existing["paylines"]        # not affected
    assert existing["paytable"]["entries"][0]["payout"] == 7  # no mutation
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_shape.py -q`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```python
# studio/backend/app/math/shape.py
"""Shape/target edit detection + sectional model merge (spec 2026-07-09 §4).

Structural sibling of app/scene/intent_rebuild.py: pure decisions here, the
store-wired orchestrator lives in realize_flow.py (Task 5)."""
from app.math.models import SectionLocks

SHAPE_FIELDS: dict[str, set[str]] = {
    "math-model": {"reels", "rows", "payline_mode", "payline_count"},
    "symbols-reels": {"symbols", "strip_length"},
    "bonus-features": {"features"},
}

TARGET_FIELDS: dict[str, set[str]] = {
    "math-model": {"rtp", "volatility", "bonus_hit_rate", "max_win", "hit_frequency"},
}

# GDD change -> which model sections must be re-realized. A roster change also
# reseeds strips and paytable rows (new/removed symbols invalidate both).
_SECTIONS_BY_FIELD: dict[tuple[str, str], set[str]] = {
    ("math-model", "reels"): {"reels", "paylines"},
    ("math-model", "rows"): {"reels", "paylines"},
    ("math-model", "payline_mode"): {"paylines"},
    ("math-model", "payline_count"): {"paylines"},
    ("symbols-reels", "symbols"): {"symbols", "reels", "paytable"},
    ("symbols-reels", "strip_length"): {"reels"},
    ("bonus-features", "features"): {"bonuses"},
}

# section -> SlotModel dict keys it owns
_SECTION_KEYS: dict[str, tuple[str, ...]] = {
    "symbols": ("symbols",),
    "reels": ("reels", "rows"),
    "paylines": ("paylines",),
    "paytable": ("paytable",),
    "bonuses": ("bonuses",),
}

# SectionLocks attr -> sections it blocks (symbols is never lockable)
_LOCK_BLOCKS: dict[str, set[str]] = {
    "reels": {"reels", "paylines"},
    "paytable": {"paytable"},
    "bonus": {"bonuses"},
}


def is_shape_change(aspect: str, fields: dict) -> bool:
    keys = SHAPE_FIELDS.get(aspect, set())
    return any(k in keys for k in fields)


def is_target_change(aspect: str, fields: dict) -> bool:
    keys = TARGET_FIELDS.get(aspect, set())
    return any(k in keys for k in fields)


def affected_sections(aspect: str, fields: dict) -> set[str]:
    out: set[str] = set()
    for key in fields:
        out |= _SECTIONS_BY_FIELD.get((aspect, key), set())
    return out


def merge_sections(existing: dict, realized: dict, sections: set[str],
                   locks: SectionLocks) -> dict:
    blocked: set[str] = set()
    for attr, blocks in _LOCK_BLOCKS.items():
        if getattr(locks, attr):
            blocked |= blocks
    out = dict(existing)
    for section in sections - blocked:
        for key in _SECTION_KEYS[section]:
            out[key] = realized[key]
    return out
```

- [ ] **Step 4: Run tests**

Run: `uv --directory studio/backend run pytest tests/test_shape.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A studio/backend
git commit -m "feat(math): shape/target detection and lock-respecting sectional merge"
```

---

### Task 5: `app/math/realize_flow.py` — birth/sectional orchestrator with join-key write-back

**Files:**

- Create: `studio/backend/app/math/realize_flow.py`
- Test: `studio/backend/tests/test_realize_flow.py`

**Interfaces:**

- `async def realize_game(math_store, gdd_store, game_id: str, *, aspect: str | None = None, fields: dict | None = None) -> RealizeFlowResult`
  - Reads the four GDD docs (`math-model`, `symbols-reels`, `paytable`, `bonus-features`; missing docs → `{}` data).
  - Not realizable (realizer returns `model=None`, e.g. no symbols) → `RealizeFlowResult(realized=False, errors=[...], warnings=[...])`, stores nothing.
  - Birth (`doc.origin == "template"`) → store the **whole** realized model via `math_store.save_realized`.
  - Re-realize (`origin == "realized"`, `aspect`/`fields` given) → `merge_sections(existing.model, realized, affected_sections(aspect, fields), existing.locks)` then `save_realized`.
  - Builds `existing_ids` from the GDD symbols table's `model_id` column (rows where it is a non-empty int), passes to `realize_slot_model`, and **writes back** `slot_ids` into the symbols rows via `gdd_store.set_fields(game_id, "symbols-reels", {"symbols": rows_with_model_id})` when any row's `model_id` changed. (Write-back goes through the store directly — entry-point hooks in Tasks 6–7 are the only places that call `realize_game`, so no recursion.)
- `@dataclass RealizeFlowResult: realized: bool; errors: list[str]; warnings: list[str]`
- Consumes: Task 2 `save_realized`, Task 3 `realize_slot_model(..., existing_ids)` / `RealizeResult.slot_ids`, Task 4 `affected_sections`/`merge_sections`.

- [ ] **Step 1: Write the failing tests**

```python
# studio/backend/tests/test_realize_flow.py
import pytest
from app.math.realize_flow import realize_game

GDD = {
    "math-model": {"reels": 5, "rows": 3, "payline_count": 10},
    "symbols-reels": {"symbols": [
        {"slot": "wild", "kind": "wild"}, {"slot": "a", "kind": "high"},
        {"slot": "scat", "kind": "scatter"},
    ]},
    "paytable": {},
    "bonus-features": {"features": [{"name": "FS", "trigger": "3 scat"}]},
}


async def _seed_gdd(gdd_store, game_id, data=GDD):
    await gdd_store.seed_taxonomy(game_id)
    for aspect, fields in data.items():
        if fields:
            await gdd_store.set_fields(game_id, aspect, fields)


async def test_birth_realizes_whole_model_and_writes_join_keys(math_store, gdd_store):
    await _seed_gdd(gdd_store, "g1")
    res = await realize_game(math_store, gdd_store, "g1")
    assert res.realized
    doc = await math_store.get("g1")
    assert doc.origin == "realized"
    assert len(doc.model["reels"]) == 5 and doc.model["rows"] == 3
    assert len(doc.model["bonuses"]) == 1
    sym_doc = await gdd_store.get_doc("g1", "symbols-reels")
    assert [r["model_id"] for r in sym_doc.data["symbols"]] == [0, 1, 2]


async def test_not_realizable_stores_nothing(math_store, gdd_store):
    await gdd_store.seed_taxonomy("g2")   # empty symbols table
    res = await realize_game(math_store, gdd_store, "g2")
    assert not res.realized and res.errors
    doc = await math_store.get_or_seed("g2")
    assert doc.origin == "template"


async def test_sectional_rerealize_preserves_unaffected_and_ids(math_store, gdd_store):
    await _seed_gdd(gdd_store, "g3")
    await realize_game(math_store, gdd_store, "g3")
    before = await math_store.get("g3")
    # GA-ish paytable edit that a dims change must NOT clobber
    tuned = dict(before.model)
    tuned["paytable"] = {"entries": [{"symbol": 1, "count": 5, "payout": 777}]}
    await math_store.put("g3", model=tuned, source="tuner")
    await gdd_store.set_fields("g3", "math-model", {"reels": 3})
    res = await realize_game(math_store, gdd_store, "g3",
                             aspect="math-model", fields={"reels": 3})
    assert res.realized
    doc = await math_store.get("g3")
    assert len(doc.model["reels"]) == 3                      # affected: rebuilt
    assert doc.model["paytable"]["entries"][0]["payout"] == 777  # untouched
    ids = {d["id"] for d in doc.model["symbols"]}
    assert ids == {0, 1, 2}                                  # join keys stable
```

Use the same mongo fixtures as `test_math_store.py`/`test_gdd_store.py` — add `math_store`/`gdd_store` fixtures to this file mirroring those (or lift shared ones into `conftest.py` if one already serves both).

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_realize_flow.py -q`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```python
# studio/backend/app/math/realize_flow.py
"""Store-wired GDD->SlotModel realization (spec 2026-07-09 §4-§5). Pure
decisions live in shape.py / realize.py; this module reads the GDD, realizes,
merges sectionally, persists, and writes the model_id join keys back."""
import logging
from dataclasses import dataclass, field

from app.math.realize import realize_slot_model
from app.math.shape import affected_sections, merge_sections

log = logging.getLogger(__name__)

_ASPECTS = ("math-model", "symbols-reels", "paytable", "bonus-features")


@dataclass(frozen=True)
class RealizeFlowResult:
    realized: bool
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _existing_ids(symbols_data: dict) -> dict[str, int]:
    out: dict[str, int] = {}
    for row in symbols_data.get("symbols") or []:
        slot = str(row.get("slot", "")).strip().lower()
        mid = row.get("model_id")
        if slot and isinstance(mid, (int, float)) and str(mid) != "":
            out[slot] = int(mid)
    return out


async def realize_game(math_store, gdd_store, game_id: str, *,
                       aspect: str | None = None,
                       fields: dict | None = None) -> RealizeFlowResult:
    data = {}
    for a in _ASPECTS:
        doc = await gdd_store.get_doc(game_id, a)
        data[a] = dict(doc.data) if doc else {}

    result = realize_slot_model(
        data["math-model"], data["symbols-reels"], data["paytable"],
        data["bonus-features"], existing_ids=_existing_ids(data["symbols-reels"]),
    )
    if result.model is None:
        return RealizeFlowResult(False, result.errors, result.warnings)

    existing = await math_store.get_or_seed(game_id)
    if existing.origin == "realized":
        # aspect=None (explicit realize endpoint) means all sections, minus locks
        sections = (affected_sections(aspect, fields or {}) if aspect
                    else {"symbols", "reels", "paylines", "paytable", "bonuses"})
        model = merge_sections(existing.model, result.model, sections,
                               existing.locks)
    else:
        model = result.model  # birth: whole realized model
    await math_store.save_realized(game_id, model)

    # join-key write-back (spec §5) — direct store call, no entry-point hook
    rows = [dict(r) for r in data["symbols-reels"].get("symbols") or []]
    changed = False
    for row in rows:
        slot = str(row.get("slot", "")).strip().lower()
        new_id = (result.slot_ids or {}).get(slot)
        if new_id is not None and row.get("model_id") != new_id:
            row["model_id"] = new_id
            changed = True
    if changed:
        await gdd_store.set_fields(game_id, "symbols-reels", {"symbols": rows})

    return RealizeFlowResult(True, result.errors, result.warnings)
```

Note: `gdd_store.set_fields` normalizes table rows against the schema columns — `model_id` is a column since Task 1, so it round-trips. If table normalization coerces `model_id` to a string, coerce back in `_existing_ids` (the `isinstance` guard above then needs a `str.isdigit()` branch — add it only if the test proves it).

- [ ] **Step 4: Run tests**

Run: `uv --directory studio/backend run pytest tests/test_realize_flow.py tests/ -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A studio/backend
git commit -m "feat(math): realize_game orchestrator — birth, sectional merge, join-key write-back"
```

---

### Task 6: REST entry point — shape hook on `PUT /gdd/{aspect}`, explicit realize endpoint, target-staleness

**Files:**

- Modify: `studio/backend/app/rest.py` (the `set_gdd_fields_rest` handler, around line 131)
- Modify: `studio/backend/app/math/rest.py` (new realize endpoint)
- Test: `studio/backend/tests/e2e/test_gdd_rest.py` (extend), `studio/backend/tests/e2e/test_math_rest.py` or the existing math REST test file (extend)

**Interfaces:**

- `PUT /games/{game_id}/gdd/{aspect}` response gains `"realize": "applied" | "pending" | None`:
  - shape change + model untouched → run `realize_game` → `"applied"`.
  - shape change + model `touched` → do NOT realize; `math_store.set_stale_flags(game_id, shape_stale=True)` → `"pending"` (the GDD keeps the new value; UI offers apply/revert — Task 9).
  - target change + a `result`/`tune_result` exists → `set_stale_flags(verdict_stale=True)`.
- `POST /games/{game_id}/slot-model/realize` (in `app/math/rest.py`) — the explicit approve: calls `realize_game(math_store, gdd_store, game_id)` with no aspect/fields, which on a realized model re-realizes **all sections minus locks** (Task 5's contract). Returns `{"realized": bool, "errors": [...], "warnings": [...]}`; on success `shape_stale` clears (done by `save_realized`).
- Consumes: Task 4 `is_shape_change`/`is_target_change`, Task 5 `realize_game`, Task 2 flags.

- [ ] **Step 1: Write the failing tests**

Extend `tests/e2e/test_gdd_rest.py` (it already has an app/client fixture over the REST API; follow its patterns):

```python
async def test_shape_edit_on_untouched_model_realizes(client):
    gid = await _new_game(client)
    await _put_gdd(client, gid, "symbols-reels",
                   {"symbols": [{"slot": "a", "kind": "high"}]})
    r = await _put_gdd(client, gid, "math-model", {"reels": 4, "rows": 3})
    assert r["realize"] == "applied"
    model = (await client.get(f"/games/{gid}/slot-model")).json()
    assert len(model["model"]["reels"]) == 4
    assert model["origin"] == "realized"


async def test_shape_edit_on_touched_model_goes_pending(client):
    gid = await _new_game(client)
    await _put_gdd(client, gid, "symbols-reels",
                   {"symbols": [{"slot": "a", "kind": "high"}]})
    await _put_gdd(client, gid, "math-model", {"reels": 4})
    # human edit -> touched
    doc = (await client.get(f"/games/{gid}/slot-model")).json()
    await client.put(f"/games/{gid}/slot-model", json={"model": doc["model"]})
    r = await _put_gdd(client, gid, "math-model", {"reels": 3})
    assert r["realize"] == "pending"
    doc = (await client.get(f"/games/{gid}/slot-model")).json()
    assert doc["shapeStale"] is True
    assert len(doc["model"]["reels"]) == 4          # model untouched


async def test_explicit_realize_applies_and_clears_shape_stale(client):
    gid = await _new_game(client)
    await _put_gdd(client, gid, "symbols-reels",
                   {"symbols": [{"slot": "a", "kind": "high"}]})
    await _put_gdd(client, gid, "math-model", {"reels": 4})
    doc = (await client.get(f"/games/{gid}/slot-model")).json()
    await client.put(f"/games/{gid}/slot-model", json={"model": doc["model"]})
    await _put_gdd(client, gid, "math-model", {"reels": 3})
    r = (await client.post(f"/games/{gid}/slot-model/realize")).json()
    assert r["realized"] is True
    doc = (await client.get(f"/games/{gid}/slot-model")).json()
    assert doc["shapeStale"] is False
    assert len(doc["model"]["reels"]) == 3


async def test_target_edit_after_result_sets_verdict_stale(client, seeded_result):
    gid = seeded_result  # fixture: game with a stored tune_result
    await _put_gdd(client, gid, "math-model", {"rtp": "94%"})
    doc = (await client.get(f"/games/{gid}/slot-model")).json()
    assert doc["verdictStale"] is True
```

Write `_new_game`/`_put_gdd`/`seeded_result` helpers if the file lacks equivalents (it has close analogues — reuse).

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/e2e/test_gdd_rest.py -q`
Expected: FAIL (`realize` key absent, endpoint 404).

- [ ] **Step 3: Implement**

In `app/rest.py`, extend `set_gdd_fields_rest` (keep the intent-rebuild lines):

```python
@router.put("/games/{game_id}/gdd/{aspect}")
async def set_gdd_fields_rest(
    game_id: str, aspect: str, body: SetGddFieldsBody, request: Request
) -> dict:
    hub = request.app.state.gdd_hub
    await request.app.state.gdd_store.seed_taxonomy(game_id)  # idempotent
    doc, warnings = await hub.set_fields(game_id, aspect, body.fields)  # emits gdd_doc_updated
    rebuilt = False
    if is_intent_change(aspect, body.fields):
        rebuilt = (await rebuild_after_intent(request.app.state, game_id)) is not None
    realize = await apply_math_hooks(request.app.state, game_id, aspect, body.fields)
    return {"doc": gdd_wire(doc), "warnings": warnings, "rebuilt": rebuilt,
            "realize": realize}
```

Put the hook logic beside the flow (add to `app/math/realize_flow.py`, imported by `app/rest.py`):

```python
async def apply_math_hooks(app_state, game_id: str, aspect: str,
                           fields: dict) -> str | None:
    """Shape/target side-effects of a persisted GDD edit (spec §4). Best-effort:
    like the scene reflow, a failure must not fail the save's PUT."""
    from app.math.shape import is_shape_change, is_target_change

    math_store = app_state.math_store
    gdd_store = app_state.gdd_store
    try:
        if is_target_change(aspect, fields):
            doc = await math_store.get_or_seed(game_id)
            if doc.result is not None or doc.tune_result is not None:
                await math_store.set_stale_flags(game_id, verdict_stale=True)
        if not is_shape_change(aspect, fields):
            return None
        doc = await math_store.get_or_seed(game_id)
        if doc.touched:
            await math_store.set_stale_flags(game_id, shape_stale=True)
            return "pending"
        res = await realize_game(math_store, gdd_store, game_id,
                                 aspect=aspect, fields=fields)
        return "applied" if res.realized else None
    except Exception:  # noqa: BLE001 — the GDD save stays authoritative
        log.warning("math hook after GDD edit failed for game %s", game_id,
                    exc_info=True)
        return None
```

(Confirm the app-state attribute name for the math store in `main.py` — it is the store handed to `app/math/rest.py`; use that exact name.)

In `app/math/rest.py`, add:

```python
@router.post("/games/{game_id}/slot-model/realize")
async def realize_slot_model_rest(game_id: str, request: Request) -> dict:
    from app.math.realize_flow import realize_game
    res = await realize_game(request.app.state.math_store,
                             request.app.state.gdd_store, game_id)
    return {"realized": res.realized, "errors": res.errors,
            "warnings": res.warnings}
```

(`realize_game` already treats `aspect=None` on a realized model as "all sections minus locks" — Task 5.)

- [ ] **Step 4: Run tests**

Run: `uv --directory studio/backend run pytest tests/e2e/test_gdd_rest.py tests/test_realize_flow.py tests/ -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A studio/backend
git commit -m "feat(gdd): shape/target hooks on GDD PUT and explicit slot-model realize endpoint"
```

---

### Task 7: Chat entry point — gated re-realize in `set_gdd_fields`, `num_bonuses` from GDD, router prompt

**Files:**

- Modify: `studio/backend/app/agent_tools.py` (`build_set_gdd_fields_tool` ~line 922; `read_tuner_setup`/`tune_slot_model` num_bonuses call sites ~lines 1288/1410)
- Modify: `studio/backend/app/math/targets.py` (new helper)
- Modify: `studio/backend/app/math/hub.py` (`_derive_target` ~line 71), `studio/backend/app/math/rest.py` (`/tuner/target` ~line 96)
- Modify: `studio/backend/app/gdd/router.py` (`_BODY_TEMPLATE`)
- Test: `studio/backend/tests/test_agent_tools.py` (extend; it has ToolContext fixtures), `studio/backend/tests/test_targets.py` (extend)

**Interfaces:**

- `targets.py` gains:

```python
def derive_num_bonuses(features_data: dict, model: dict) -> int:
    """Bonus-band count. GDD features are the intent (spec §5); the model must
    agree once realized — disagreement means the model needs re-realization and
    must fail loudly, not tune against the wrong band count."""
    features = features_data.get("features") or []
    model_count = len(model.get("bonuses") or [])
    if not features:
        return model_count
    if len(features) != model_count:
        raise TargetGap(
            f"GDD declares {len(features)} bonus feature(s) but the realized "
            f"model has {model_count}; re-realize the model (shape is stale)."
        )
    return len(features)
```

- Every `num_bonuses=len(...bonuses...)` call site (hub `_derive_target`, math REST `/tuner/target`, agent tools `read_tuner_setup`/`tune_slot_model`) switches to `derive_num_bonuses(features_doc.data, model)` where `features_doc = await gdd_store.get_doc(game_id, "bonus-features")` (missing doc → `{}`).
- `set_gdd_fields` chat tool: after a successful `set_fields`, run target-staleness, then shape logic — untouched → silent `realize_game`; touched → `interrupt()` gate (approve → `realize_game`, deny → `shape_stale=True`). `ToolContext` must expose `math_store` (it already carries store singletons; add `math_store` if absent — check the dataclass fields and the builders in `room_hub.py`/`intent_rebuild.py`-style construction sites).
- Router: `_BODY_TEMPLATE` branch (1) gains one sentence: "Shape fields (reels, rows, paylines, the symbols table, features) re-realize the game's math model; if the model has been hand-tuned the studio will ask the human to approve first."

- [ ] **Step 1: Write the failing tests**

`tests/test_targets.py`:

```python
import pytest
from app.math.targets import TargetGap, derive_num_bonuses


def test_num_bonuses_prefers_gdd_when_consistent():
    assert derive_num_bonuses({"features": [{"name": "FS"}]},
                              {"bonuses": [{"FreeSpins": {}}]}) == 1


def test_num_bonuses_falls_back_to_model_when_gdd_empty():
    assert derive_num_bonuses({}, {"bonuses": [{"FreeSpins": {}}]}) == 1
    assert derive_num_bonuses({"features": []}, {"bonuses": []}) == 0


def test_num_bonuses_raises_on_drift():
    with pytest.raises(TargetGap):
        derive_num_bonuses({"features": [{"name": "a"}, {"name": "b"}]},
                           {"bonuses": [{"FreeSpins": {}}]})
```

`tests/test_agent_tools.py` — follow the file's existing pattern for exercising a tool with a stub interrupt (the approval-gate tests for `rebuild_scene`/`apply_tuned_model` show how `interrupt` is monkeypatched):

```python
async def test_set_gdd_fields_shape_untouched_realizes_silently(ctx, monkeypatch):
    calls = []
    monkeypatch.setattr("app.agent_tools.interrupt",
                        lambda payload: calls.append(payload) or "approve")
    await _seed_symbols(ctx)  # helper: symbols table so the game is realizable
    tool = build_set_gdd_fields_tool(ctx)
    out = await tool.coroutine(aspect="math-model", fields={"reels": 4})
    assert calls == []                       # no gate on untouched model
    doc = await ctx.math_store.get(ctx.game_id)
    assert doc.origin == "realized" and len(doc.model["reels"]) == 4
    assert "realized" in out.lower()


async def test_set_gdd_fields_shape_touched_gates_and_deny_marks_stale(ctx, monkeypatch):
    monkeypatch.setattr("app.agent_tools.interrupt", lambda payload: "deny")
    await _seed_symbols(ctx)
    await ctx.math_store.put(ctx.game_id, model={"rows": 3}, source="api")  # touched
    tool = build_set_gdd_fields_tool(ctx)
    out = await tool.coroutine(aspect="math-model", fields={"reels": 4})
    doc = await ctx.math_store.get(ctx.game_id)
    assert doc.shape_stale is True
    assert "stale" in out.lower() or "declined" in out.lower()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_targets.py tests/test_agent_tools.py -q`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add `derive_num_bonuses` to `targets.py` exactly as in Interfaces. Update the four call sites; each currently computes `num_bonuses` from the model doc (e.g. `hub.py:73`) — replace with:

```python
        features_doc = await self._gdd_store.get_doc(game_id, "bonus-features")
        num_bonuses = derive_num_bonuses(
            features_doc.data if features_doc else {}, doc.model)
```

(`MathHub` already holds `gdd_store`; the REST endpoint and agent tools reach it the same way they reach the math-model doc today.)

Rewrite the tool body in `build_set_gdd_fields_tool`:

```python
    async def set_gdd_fields(aspect: str, fields: dict) -> str:
        try:
            doc, warnings = await ctx.gdd_hub.set_fields(ctx.game_id, aspect, fields)
        except GddEditError as e:
            return f"Could not update '{aspect}': {e}"
        msg = (f"Updated '{aspect}' ({', '.join(fields.keys())}); "
               f"status now {doc.status}.")
        if warnings:
            msg += " Warnings: " + "; ".join(warnings)

        if is_target_change(aspect, fields):
            mdoc = await ctx.math_store.get_or_seed(ctx.game_id)
            if mdoc.result is not None or mdoc.tune_result is not None:
                await ctx.math_store.set_stale_flags(ctx.game_id, verdict_stale=True)
                msg += " The last math verdict is now stale — re-verify."

        if is_shape_change(aspect, fields):
            mdoc = await ctx.math_store.get_or_seed(ctx.game_id)
            if mdoc.touched:
                label = ("Re-realize the math model to the new design shape? "
                         "Hand-edited/tuned values in the affected sections "
                         "will be regenerated (locked sections are kept).")
                decision = interrupt(
                    {"tool": "set_gdd_fields", "args": {"aspect": aspect},
                     "label": label})
                if decision != "approve":
                    await ctx.math_store.set_stale_flags(ctx.game_id, shape_stale=True)
                    return msg + (" Re-realize declined — the model is now marked "
                                  "shape-stale until it is re-realized or the "
                                  "design is reverted.")
            res = await realize_game(ctx.math_store, ctx.gdd_store, ctx.game_id,
                                     aspect=aspect, fields=fields)
            if res.realized:
                msg += " Model re-realized to the new shape."
            elif res.errors:
                msg += " Model not realized: " + "; ".join(res.errors)
        return msg
```

Imports at the top of `agent_tools.py`: `from app.math.realize_flow import realize_game` and `from app.math.shape import is_shape_change, is_target_change`. Add `math_store` to `ToolContext` if it isn't a field yet, and thread it at every ToolContext construction site (grep `ToolContext(` — `room_hub.py`, `scene/intent_rebuild.py`, tests; the tuner tools already reach a math store via ctx, so it likely exists — verify first).

Add the one router sentence to `_BODY_TEMPLATE` branch (1) in `app/gdd/router.py`.

- [ ] **Step 4: Run tests**

Run: `uv --directory studio/backend run pytest tests/test_targets.py tests/test_agent_tools.py tests/ -q`
Expected: PASS (full suite — the num_bonuses change touches curate/tune paths; their tests must stay green: any fixture with model bonuses but no GDD features falls back to model count by design).

- [ ] **Step 5: Commit**

```bash
git add -A studio/backend
git commit -m "feat(chat): gated re-realize in set_gdd_fields and GDD-derived num_bonuses"
```

---

### Task 8: Frontend — GDD mirrors (paytable + bonuses from the live model)

**Files:**

- Create: `studio/frontend/src/plugins/gdd/MirrorSection.tsx`
- Modify: `studio/frontend/src/plugins/gdd/GddViewerPane.tsx`
- Modify: `studio/frontend/src/plugins/gdd/actions.ts` (or its restClient — add `getSlotModel(gameId)`)
- Test: `studio/frontend/src/plugins/gdd/MirrorSection.test.tsx`

**Interfaces:**

- `IMirrorModel` (in `MirrorSection.tsx`): `{ symbols: {id: number; role: string}[]; paytable: {entries: {symbol: number; count: number; payout: number}[]}; bonuses: unknown[] }` — the wire subset the mirror reads.
- `<MirrorSection aspect={'paytable' | 'bonus-features'} model={IMirrorModel | null} names={Map<number, string>} />` — pure presentational; renders a table of realized paytable entries (symbol name via `names`, falling back to `#id`) or realized bonuses, under the heading **“Realized — from the game model”**, `data-testid="gdd-mirror-<aspect>"`. Renders nothing when `model` is null.
- `GddViewerPane` builds `names` from the symbols-reels doc rows (`model_id` → `name || slot`), fetches the slot model on mount/game change via `getSlotModel`, and refreshes on the `slot_model_changed` socket event (subscribe the same way the game-config plugin does — read `plugins/game-config` state wiring for the event name/payload and mirror the pattern; do not duplicate a second socket connection if the shared socket client is importable).
- When `shapeStale` is true on the fetched doc, the affected aspects show a warning line with `data-testid="gdd-shape-stale"` and a **“Re-realize model”** button that POSTs `/games/{id}/slot-model/realize`.

- [ ] **Step 1: Write the failing test**

```tsx
// studio/frontend/src/plugins/gdd/MirrorSection.test.tsx
import { render, screen } from '@testing-library/react';
import { MirrorSection } from './MirrorSection';

const model = {
  symbols: [
    { id: 0, role: 'wild' },
    { id: 1, role: 'normal' },
  ],
  paytable: { entries: [{ symbol: 0, count: 5, payout: 500 }] },
  bonuses: [{ FreeSpins: { config: { spins_awarded: 10 } } }],
};
const names = new Map([
  [0, 'Wild'],
  [1, 'Thor'],
]);

it('renders realized paytable rows with symbol names', () => {
  render(<MirrorSection aspect="paytable" model={model} names={names} />);
  expect(screen.getByTestId('gdd-mirror-paytable')).toHaveTextContent('Realized');
  expect(screen.getByTestId('gdd-mirror-paytable')).toHaveTextContent('Wild');
  expect(screen.getByTestId('gdd-mirror-paytable')).toHaveTextContent('500');
});

it('renders bonuses for bonus-features aspect', () => {
  render(<MirrorSection aspect="bonus-features" model={model} names={names} />);
  expect(screen.getByTestId('gdd-mirror-bonus-features')).toHaveTextContent('Free spins');
});

it('renders nothing without a model', () => {
  const { container } = render(<MirrorSection aspect="paytable" model={null} names={names} />);
  expect(container).toBeEmptyDOMElement();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx nx test frontend -- MirrorSection` (or the repo's vitest filter equivalent — check how other single-file runs are invoked in `plugins/*/`_.test.tsx_ docs)
Expected: FAIL (component missing).

- [ ] **Step 3: Implement**

`MirrorSection.tsx` — pure component, design-language classes only (text tiers `text-text-2/3`, hairline borders; no raw colors):

```tsx
export interface IMirrorModel {
  symbols: { id: number; role: string }[];
  paytable: { entries: { symbol: number; count: number; payout: number }[] };
  bonuses: unknown[];
}

export function MirrorSection({ aspect, model, names }: { aspect: 'paytable' | 'bonus-features'; model: IMirrorModel | null; names: Map<number, string> }) {
  if (!model) return null;
  const name = (id: number) => names.get(id) ?? `#${id}`;
  return (
    <div data-testid={`gdd-mirror-${aspect}`} className="mt-4 border-t border-hairline pt-3">
      <div className="mb-2 text-xs uppercase tracking-wide text-text-3">Realized — from the game model</div>
      {aspect === 'paytable' ? (
        <table className="w-full text-sm text-text-2">
          <thead>
            <tr className="text-left text-text-3">
              <th>Symbol</th>
              <th>Count</th>
              <th>Pays (x bet)</th>
            </tr>
          </thead>
          <tbody>
            {model.paytable.entries.map((e, i) => (
              <tr key={i}>
                <td>{name(e.symbol)}</td>
                <td>{e.count}</td>
                <td>{e.payout}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <ul className="text-sm text-text-2">
          {model.bonuses.map((b, i) => {
            const fs = (b as Record<string, { config?: { spins_awarded?: number } }>)['FreeSpins'];
            return <li key={i}>Free spins{fs?.config?.spins_awarded ? ` — ${fs.config.spins_awarded} awarded` : ''}</li>;
          })}
        </ul>
      )}
    </div>
  );
}
```

Wire into `GddViewerPane` after the `<Markdown>` block: fetch the slot-model doc for `activeGameId` (new `getSlotModel` in the gdd plugin's rest client, `GET /games/{gameId}/slot-model`), keep it in component state, re-fetch on `slot_model_changed` (mirror the game-config plugin's subscription), derive `names` from `docs.find(d => d.aspect === 'symbols-reels')?.data?.symbols` rows (`model_id` → `name || slot`), and render `<MirrorSection>` when `current.aspect` is `paytable` or `bonus-features`. Add the `shapeStale` warning + “Re-realize model” button (POST `/games/{id}/slot-model/realize`, then re-fetch) guarded to shape-affected aspects (`math-model`, `symbols-reels`, `bonus-features`).

- [ ] **Step 4: Run frontend gates**

Run: `node_modules/.bin/prettier --check . && npx nx run-many -t typecheck test`
Expected: PASS (run from the worktree root; `npm install` first if `node_modules` is missing in the fresh worktree).

- [ ] **Step 5: Commit**

```bash
git add -A studio/frontend
git commit -m "feat(gdd): read-only realized mirrors for paytable and bonuses with re-realize affordance"
```

---

### Task 9: Frontend — STALE verdict badge (math pane) and shape-stale pill (game-config)

**Files:**

- Modify: `studio/frontend/src/plugins/math/components/ResultStrip.tsx` (verdict badge area) and the math plugin state that receives `slot_model_changed` (it already re-hydrates the doc — locate where `verdict`/`tune_result` reach ResultStrip and thread `verdictStale`)
- Modify: `studio/frontend/src/plugins/game-config/GameConfigPane.tsx` (sync-status pill strip) and its state wiring for `shapeStale`
- Test: extend the existing component tests beside each pane (`plugins/math/**/*.test.tsx`, `plugins/game-config/**/*.test.tsx` — follow their render-with-state patterns)

**Interfaces:**

- Math pane: when the doc's `verdictStale` is true and a verdict exists and no run is in flight, the verdict badge row shows a `STALE` chip (`data-testid="math-verdict-stale"`, styled like the existing RUNNING badge — reuse its chip classes) with title text "Design intent or model changed since this verdict — re-verify." The PR #155/#152 rule stands: RUNNING while in flight; a fresh verify clears the chip (backend clears the flag; UI just renders it).
- Game-config pane: when `shapeStale` is true the sync strip shows a warning pill `data-testid="config-shape-stale"` with text "Design shape differs — re-realize or revert" — display-only (the action button lives in the GDD viewer, Task 8).

- [ ] **Step 1: Write the failing tests**

In the math plugin's existing ResultStrip (or verdict-badge) test file, add:

```tsx
it('shows STALE chip when verdictStale and idle', () => {
  renderResultStrip({ verdict: 'pass', verdictStale: true, running: false });
  expect(screen.getByTestId('math-verdict-stale')).toBeInTheDocument();
});

it('hides STALE chip while a run is in flight', () => {
  renderResultStrip({ verdict: 'pass', verdictStale: true, running: true });
  expect(screen.queryByTestId('math-verdict-stale')).toBeNull();
});
```

(`renderResultStrip` = whatever helper the file already uses to mount with plugin state; extend it to accept `verdictStale`.) In the game-config pane test file:

```tsx
it('shows shape-stale pill when the doc is shape-stale', () => {
  renderPane({ shapeStale: true });
  expect(screen.getByTestId('config-shape-stale')).toHaveTextContent('re-realize or revert');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx nx test frontend` (filtered to the two files)
Expected: FAIL.

- [ ] **Step 3: Implement**

Thread `verdictStale`/`shapeStale` from the `slot_model_changed` payload (the doc wire already carries them after Task 2 — camelCase via the alias generator) into each plugin's hookstate. Render the chip/pill per Interfaces, copying the exact class strings from the RUNNING badge and the existing sync pill so the design language stays intact.

- [ ] **Step 4: Run frontend gates**

Run: `node_modules/.bin/prettier --check . && npx nx run-many -t typecheck test build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A studio/frontend
git commit -m "feat(math): STALE verdict chip and shape-stale config pill"
```

---

### Task 10: Lazy GDD data migration — strip evicted keys on read

**Files:**

- Modify: `studio/backend/app/gdd/store.py` (`_from_doc`)
- Test: `studio/backend/tests/test_gdd_store.py` (extend)

**Interfaces:**

- `_from_doc` filters `data` to keys present in the aspect's schema (evicted keys vanish on read; spec §9 — they were unread fiction). Unknown aspects (defensive) pass through unfiltered.

- [ ] **Step 1: Write the failing test**

```python
async def test_evicted_keys_stripped_on_read(gdd_store):
    await gdd_store.seed_taxonomy("g9")
    # simulate a pre-rework doc with evicted keys persisted
    await gdd_store._docs.update_one(
        {"game_id": "g9", "aspect": "paytable"},
        {"$set": {"data": {"payouts": [{"symbol": "a"}], "notes": "keep"}}},
    )
    doc = await gdd_store.get_doc("g9", "paytable")
    assert "payouts" not in doc.data
    assert doc.data["notes"] == "keep"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_gdd_store.py -q`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `app/gdd/store.py`:

```python
from app.gdd.schemas import ASPECT_SCHEMAS, schema_for


def _from_doc(raw: dict) -> GddDoc:
    data = dict(raw)
    data["id"] = data.pop("_id")
    aspect = data.get("aspect")
    if aspect in ASPECT_SCHEMAS and isinstance(data.get("data"), dict):
        allowed = {f.key for f in ASPECT_SCHEMAS[aspect]}
        data["data"] = {k: v for k, v in data["data"].items() if k in allowed}
    return GddDoc.model_validate(data)
```

- [ ] **Step 4: Run tests**

Run: `uv --directory studio/backend run pytest tests/test_gdd_store.py tests/ -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A studio/backend
git commit -m "feat(gdd): lazily strip evicted fields from persisted GDD data on read"
```

---

### Task 11: Playwright e2e — the full ownership loop (REST-driven)

**Files:**

- Create: `studio/frontend/e2e/gdd-ownership.spec.ts`
- Consult: `studio/frontend/e2e/` existing specs for helpers (backend REST base URL derives from `BLOOM_PORT_OFFSET`; see the e2e helpers), and the seeding patterns from `inspector-mutation-roundtrip.spec.ts`.

**Interfaces:** asserts observable end-state per repo doctrine (never dispatch-only): mirrors update, badges appear/clear, model persists.

- [ ] **Step 1: Write the spec**

```ts
// studio/frontend/e2e/gdd-ownership.spec.ts
import { expect, test } from '@playwright/test';
import { apiBase, createGameRoom, openPane } from './helpers'; // use the real helper names in e2e/

test('shape edit realizes the model, mirrors it, and staleness round-trips', async ({ page, request }) => {
  const { roomUrl, gameId } = await createGameRoom(request);

  // 1. seed a realizable design via REST (symbols + dims)
  await request.put(`${apiBase()}/games/${gameId}/gdd/symbols-reels`, {
    data: {
      fields: {
        symbols: [
          { slot: 'wild', name: 'Wild', kind: 'wild' },
          { slot: 'thor', name: 'Thor', kind: 'high' },
          { slot: 'scat', name: 'Scatter', kind: 'scatter' },
        ],
      },
    },
  });
  const r1 = await request.put(`${apiBase()}/games/${gameId}/gdd/math-model`, {
    data: { fields: { reels: 4, rows: 3, rtp: '96%', volatility: 'medium', bonus_hit_rate: '1:200' } },
  });
  expect((await r1.json()).realize).toBe('applied');

  // 2. the GDD viewer mirrors the realized paytable with symbol names
  await page.goto(roomUrl);
  await openPane(page, 'Game Design Document');
  await page.getByTestId('gdd-aspect-paytable').click();
  await expect(page.getByTestId('gdd-mirror-paytable')).toContainText('Thor');

  // 3. human edit -> touched; next shape edit goes pending + shape-stale pill
  const doc = await (await request.get(`${apiBase()}/games/${gameId}/slot-model`)).json();
  await request.put(`${apiBase()}/games/${gameId}/slot-model`, { data: { model: doc.model } });
  const r2 = await request.put(`${apiBase()}/games/${gameId}/gdd/math-model`, {
    data: { fields: { reels: 3 } },
  });
  expect((await r2.json()).realize).toBe('pending');
  await openPane(page, 'Game Config');
  await expect(page.getByTestId('config-shape-stale')).toBeVisible();

  // 4. re-realize from the GDD viewer clears it and applies the shape
  await openPane(page, 'Game Design Document');
  await page.getByTestId('gdd-aspect-math-model').click();
  await page
    .getByTestId('gdd-shape-stale')
    .getByRole('button', { name: /re-realize/i })
    .click();
  await expect(page.getByTestId('config-shape-stale')).toBeHidden();
  const after = await (await request.get(`${apiBase()}/games/${gameId}/slot-model`)).json();
  expect(after.model.reels).toHaveLength(3);
  expect(after.shapeStale).toBe(false);
});
```

Adapt helper names/selectors to the real `e2e/` toolkit (`createGameRoom` equivalents exist in the asset/gdd specs; the pane-open helper is in the shared e2e utils). Add a second test asserting the STALE math chip: seed + realize, run a Verify via `POST /games/{id}/slot-model/curate` replay flow if a cassette exists — if no cheap replay path exists for a verdict, assert instead via `set_stale_flags`-inducing REST edit after seeding `tune_result` through the replay backend's existing cassette game, per the tuner e2e's seeding recipe. Keep it observable-end-state.

- [ ] **Step 2: Run the suite against the replay backend**

```bash
just backend-serve-replay   # worktree offset 1 -> :8001 (leave running)
just e2e                    # in a second shell, same worktree
```

Expected: new spec fails first (badges/mirrors not yet reachable?) — if it fails for selector/helper reasons, fix the spec; if for product reasons, fix the product code from Tasks 6–9. Iterate to green, and the FULL suite must stay green (86+ specs).

- [ ] **Step 3: Commit**

```bash
git add -A studio/frontend/e2e
git commit -m "test(e2e): gdd ownership loop — realize, mirror, staleness round-trip"
```

---

### Task 12: Full gates, PR

- [ ] **Step 1: Backend suite** — `uv --directory studio/backend run pytest tests/ -q` → all green.
- [ ] **Step 2: Frontend gates** — `node_modules/.bin/prettier --check .`, `npx nx run-many -t typecheck test build` → all green.
- [ ] **Step 3: Playwright** — `just e2e` full suite against the replay backend on :8001 → green.
- [ ] **Step 4: Push + PR**

```bash
git push -u origin feat/gdd-slotmodel-sot
gh pr create --title "feat(gdd): GDD/SlotModel single source of truth — ownership rework (Plan 1)" --body "Implements Plan 1 of docs/superpowers/specs/2026-07-09-gdd-slotmodel-source-of-truth-design.md: schema eviction + pay_constraints + model_id join key, birth/sectional gated re-realization, GDD mirrors, staleness flags/badges, GDD-derived num_bonuses, lazy migration. Plan 2 (Rust constraint seam) follows.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 5: Request review** per superpowers:requesting-code-review, then finish via /bloom:complete-work.

---

## Self-review notes (already applied)

- Spec §4 REST pending-state approve/revert: approve = the explicit realize endpoint (Task 6) surfaced as the GDD-viewer button (Task 8); revert = the user re-edits the shape fields back, after which the next silent/gated realize converges. No dedicated revert endpoint (YAGNI — reverting the GDD field re-runs the same hook).
- Spec §5 `derive_target` constraint compilation and §6 (TargetSpec/GA) are Plan 2; this plan stops at the honest schema + `derive_num_bonuses`.
- `pay_constraints` is added to the schema in Task 1 but consumed by nothing until Plan 2 — it is intent capture, rendered by the standard field renderer, explicitly labeled in its help text.

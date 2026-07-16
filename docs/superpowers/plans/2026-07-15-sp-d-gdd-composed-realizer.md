# SP-D — GDD→Composed Realizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A GDD can declare `game_family: composed@1` and structured feature intent; a pure realizer seeds the initial `GameDefinition` (states, transitions, mechanics, join keys), wired through the same touched-gate / locks / staleness lifecycle slots already has, unlocking composed pay-constraint targets.

**Architecture:** Mirror the slots realizer split exactly: pure compilation in `app/math/realize_composed.py` (reusing `realize.py`'s helpers for the `reels@1` config), store-wired orchestration via family dispatch inside the existing `realize_flow.realize_game`, persistence through `ComposeStore.put(source="realize")` so watermark/scene-sync/auto-build fire. Merge granularity for composed is the tuner's three lock groups (reels / paytable / features).

**Tech Stack:** Python 3.12 (FastAPI backend, pytest + pytest-asyncio, real Mongo via the `mongo_db` fixture), Playwright e2e (replay backend).

**Spec:** `docs/superpowers/specs/2026-07-15-sp-d-gdd-composed-realizer-design.md`

## Global Constraints

- Semantic (Conventional Commits) format for every commit, imperative mood.
- TDD mandatory: failing test → run it → minimal code → green → commit.
- Worktree: `C:\code\bloom.wt\sp-d-realizer`, branch `feat/sp-d-realizer`, `BLOOM_PORT_OFFSET=1` (backend :8001, frontend :4201). NEVER use default ports here.
- Backend tests: `uv --directory studio/backend run pytest <path> -v` (from the worktree root; native mongod on :27017 must be running).
- Markdown/TS formatting: pinned prettier only — `node_modules/.bin/prettier`, never `npx prettier`.
- TypeScript interfaces use an `I` prefix (`docs/coding-standards.md`).
- No new dependencies.
- Both families stay first-class: every slots test that exists today must stay green.

### File structure (what changes where)

| File                                               | Responsibility                                                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `studio/backend/app/gdd/schemas.py`                | + `game_family` field (math-model), + `kind`/`retrigger`/`budget` columns (bonus-features), `Column.optional`   |
| `studio/backend/app/gdd/normalize.py`              | optional columns don't warn when missing                                                                        |
| `studio/backend/app/math/realize.py`               | rename 4 shared helpers public, extract `slot_id_map` (no logic changes)                                        |
| `studio/backend/app/math/realize_composed.py`      | NEW — pure `realize_game_definition`                                                                            |
| `studio/backend/app/math/shape.py`                 | + `game_family` shape field, composed 3-group mapping + `merge_composed_groups`                                 |
| `studio/backend/app/compose/models.py`             | `GameDefinitionDoc` + `origin`, `shape_stale`                                                                   |
| `studio/backend/app/compose/store.py`              | `put(source="realize")` doesn't mark `touched`                                                                  |
| `studio/backend/app/math/store.py`                 | `_composed_view` maps origin/shape_stale/touched; `save_realized` + `set_stale_flags` composed branches go real |
| `studio/backend/app/math/realize_flow.py`          | family dispatch in `realize_game`                                                                               |
| `studio/backend/app/math/target_flow.py`           | `is_composed` public; composed targets get pay constraints                                                      |
| `studio/backend/app/agent_tools.py`                | import rename only                                                                                              |
| `studio/backend/app/math/rest.py`                  | composed realize 409 guard removed                                                                              |
| `studio/frontend/e2e/gdd-composed-realize.spec.ts` | NEW — end-to-end GDD→realize→UI flow                                                                            |

---

### Task 1: GDD schema — `game_family` + structured feature columns

**Files:**

- Modify: `studio/backend/app/gdd/schemas.py`
- Modify: `studio/backend/app/gdd/normalize.py:91`
- Test: `studio/backend/tests/test_gdd_schemas.py` (append)

**Interfaces:**

- Produces: math-model field `game_family` (enum `slots@1|composed@1`, default `slots@1`); bonus-features table columns `kind` (enum `free-spins|meter`), `retrigger` (enum `yes|no`), `budget` — all three `optional=True` (no missing-column warning). `Column` dataclass gains `optional: bool = False`.

- [ ] **Step 1: Write the failing tests** (append to `studio/backend/tests/test_gdd_schemas.py`)

```python
from app.gdd.normalize import normalize_value
from app.gdd.schemas import schema_for


def _field(aspect: str, key: str):
    return next(f for f in schema_for(aspect) if f.key == key)


def test_game_family_field_exists_and_normalizes():
    f = _field("math-model", "game_family")
    assert f.type == "enum" and f.role == "param" and f.default == "slots@1"
    assert f.enum == ("slots@1", "composed@1")
    value, warn = normalize_value(f, "COMPOSED@1")
    assert value == "composed@1" and warn is None
    _, warn = normalize_value(f, "weird")
    assert warn is not None


def test_features_table_gains_optional_composed_columns():
    f = _field("bonus-features", "features")
    cols = {c.key: c for c in f.columns}
    assert cols["kind"].enum == ("free-spins", "meter") and cols["kind"].optional
    assert cols["retrigger"].enum == ("yes", "no") and cols["retrigger"].optional
    assert "budget" in cols and cols["budget"].optional


def test_optional_columns_missing_do_not_warn():
    f = _field("bonus-features", "features")
    rows, warn = normalize_value(f, [{"name": "FS", "trigger": "3 scat",
                                      "description": "wheel"}])
    assert warn is None
    assert rows[0]["kind"] == ""          # column key still present, empty


def test_kind_enum_cell_warns_on_bad_value():
    f = _field("bonus-features", "features")
    _, warn = normalize_value(f, [{"name": "FS", "trigger": "t",
                                   "description": "", "kind": "jackpot"}])
    assert warn is not None and "jackpot" in warn
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_gdd_schemas.py -v -k "game_family or optional_composed or optional_columns or kind_enum"`
Expected: FAIL (`StopIteration` — no `game_family` field; missing columns).

- [ ] **Step 3: Implement**

In `studio/backend/app/gdd/schemas.py`, extend `Column` and `_t`:

```python
@dataclass(frozen=True)
class Column:
    key: str
    label: str
    enum: tuple[str, ...] | None = None
    optional: bool = False  # missing cell is fine — no normalize warning


def _t(*pairs: tuple) -> tuple[Column, ...]:
    return tuple(Column(*p) for p in pairs)
```

In `ASPECT_SCHEMAS["math-model"]`, after the `volatility` field, add:

```python
        Field("game_family", "Game family", "enum", "param",
              default="slots@1", enum=("slots@1", "composed@1"),
              help="Which math family realization targets: classic slots@1 "
                   "or composed@1 state-machine games."),
```

In `ASPECT_SCHEMAS["bonus-features"]`, replace the `features` Field's columns with:

```python
        Field("features", "Features", "table", "param", required=True,
              columns=_t(("name", "Name"), ("trigger", "Trigger"),
                         ("description", "Description"),
                         ("kind", "Kind", ("free-spins", "meter"), True),
                         ("retrigger", "Retrigger", ("yes", "no"), True),
                         ("budget", "Budget", None, True)),
              help="kind/retrigger/budget drive the composed@1 realizer "
                   "(budget = spins awarded for free-spins, fill target for "
                   "meter); slots@1 realization ignores them."),
```

In `studio/backend/app/gdd/normalize.py`, change the missing-column computation in `_table` (line 91):

```python
        missing = [c.key for c in cols
                   if c.key not in row and c.key not in ignore_missing
                   and not c.optional]
```

- [ ] **Step 4: Run the full gdd test files**

Run: `uv --directory studio/backend run pytest tests/test_gdd_schemas.py tests/test_gdd_store.py tests/test_gdd_models.py tests/test_gdd_render.py -v`
Expected: PASS (existing render/store tests confirm the new columns ride through untouched).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/gdd/schemas.py studio/backend/app/gdd/normalize.py studio/backend/tests/test_gdd_schemas.py
git commit -m "feat(gdd): game_family intent + structured composed feature columns"
```

---

### Task 2: Export the shared slots-realizer helpers

Pure rename refactor — no logic changes, existing tests are the safety net.

**Files:**

- Modify: `studio/backend/app/math/realize.py`
- Modify: `studio/backend/tests/test_realize.py:1-5` (imports only)

**Interfaces:**

- Produces: `realize_symbols`, `realize_reels`, `realize_paylines`, `realize_paytable` (formerly underscore-private, signatures unchanged), and NEW `slot_id_map(symbols_reels: dict, name_to_id: dict[str, int]) -> dict[str, int]`. `_realize_bonuses` stays private (slots-only).

- [ ] **Step 1: Rename in `realize.py`**

Rename `_realize_symbols` → `realize_symbols`, `_realize_reels` → `realize_reels`, `_realize_paylines` → `realize_paylines`, `_realize_paytable` → `realize_paytable` (def sites + the four call sites inside `realize_slot_model`). Then extract the `slot_ids` comprehension at the tail of `realize_slot_model` into:

```python
def slot_id_map(symbols_reels: dict, name_to_id: dict[str, int]) -> dict[str, int]:
    """{slot -> model symbol id} for the GDD model_id join-key write-back."""
    return {
        str(row.get("slot", "")).strip().lower():
            name_to_id[str(row.get("slot", "")).strip().lower()]
        for row in (symbols_reels.get("symbols") or [])
        if str(row.get("slot", "")).strip()
    }
```

and end `realize_slot_model` with:

```python
    return RealizeResult(model, errors, warnings,
                         slot_id_map(symbols_reels, name_to_id))
```

- [ ] **Step 2: Update the test import** (`studio/backend/tests/test_realize.py:1-5`)

```python
from app.math.realize import (
    RealizeResult, realize_symbols, _to_int, _to_bool, _KIND_TO_ROLE,
    realize_reels, _all_patterns, _first_n_patterns, realize_paylines,
    realize_paytable, _realize_bonuses, realize_slot_model,
)
```

Then replace every `_realize_symbols(` → `realize_symbols(`, `_realize_reels(` → `realize_reels(`, `_realize_paylines(` → `realize_paylines(`, `_realize_paytable(` → `realize_paytable(` throughout the test file.

- [ ] **Step 3: Run the realizer tests**

Run: `uv --directory studio/backend run pytest tests/test_realize.py tests/test_realize_flow.py tests/e2e/test_realize_parity.py -v`
Expected: PASS, same counts as before the rename.

- [ ] **Step 4: Commit**

```bash
git add studio/backend/app/math/realize.py studio/backend/tests/test_realize.py
git commit -m "refactor(math): export shared realizer helpers for the composed realizer"
```

---

### Task 3: Pure composed realizer — `realize_game_definition`

**Files:**

- Create: `studio/backend/app/math/realize_composed.py`
- Test: `studio/backend/tests/test_realize_composed.py` (new)

**Interfaces:**

- Consumes: Task 2's `realize_symbols` / `realize_reels` / `realize_paylines` / `realize_paytable` / `slot_id_map`, plus `RealizeResult`, `_to_int`, `_to_bool`, `BONUS_MIN_COUNT`, `DEFAULT_REELS`, `DEFAULT_ROWS`, `MAX_REELS`, `MAX_ROWS` from `app.math.realize`.
- Produces: `realize_game_definition(math_model, symbols_reels, paytable, bonus_features, existing_ids=None) -> RealizeResult` where `result.model` is a composed@1 `GameDefinition` dict (or `None` on hard contradiction) and `result.slot_ids` is the join-key map. Constants `SCATTER_EVENT = "scatters:3"`, `DEFAULT_FS_SPINS = 8`, `DEFAULT_METER_TARGET = 6`, `METER_STATE_BUDGET = 5`, `MAX_STEPS = 1000`. State ids: `fs_<i>` / `meter_<i>_bonus`; meter mechanic ids `meter_<i>`, per-meter event `meter<i>:full` (i = 1-based feature row index).

- [ ] **Step 1: Write the failing tests** (`studio/backend/tests/test_realize_composed.py`)

```python
from app.math.realize_composed import (
    DEFAULT_FS_SPINS, DEFAULT_METER_TARGET, METER_STATE_BUDGET,
    SCATTER_EVENT, realize_game_definition,
)

_MATH = {"rtp": "0.96", "volatility": "high", "reels": 3, "rows": 3,
         "payline_mode": "lines", "payline_count": 3}
_SYMBOLS = {"symbols": [
    {"slot": "high1", "name": "Dragon", "kind": "high"},
    {"slot": "low1", "name": "Ten", "kind": "low"},
    {"slot": "scat", "name": "Coin", "kind": "scatter"},
], "strip_length": {"min": 20, "max": 20}}
_PAYTABLE = {"payouts": [{"symbol": "Dragon", "3oak": "5"}]}
_FEATURES = {"features": [
    {"name": "Free Spins", "trigger": "3 scatters", "kind": "free-spins",
     "retrigger": "yes", "budget": "10"},
    {"name": "Coin Meter", "trigger": "meter", "kind": "meter", "budget": "7"},
]}


def _realize(features=_FEATURES, math=_MATH, symbols=_SYMBOLS):
    return realize_game_definition(math, symbols, _PAYTABLE, features)


def test_golden_full_definition():
    res = _realize()
    assert res.errors == []
    d = res.model
    assert d["family"] == "composed@1"
    assert d["start"] == "base"
    assert d["caps"] == {"max_steps": 1000}
    # one reels mechanic + one meter mechanic
    reels = d["mechanics"][0]
    assert reels["id"] == "main_reels" and reels["type"] == "reels@1"
    cfg = reels["config"]
    assert len(cfg["strips"]) == 3 and cfg["rows"] == 3
    assert len(cfg["paylines"]) == 3
    assert cfg["symbols"] == [
        {"id": 0, "role": "normal"}, {"id": 1, "role": "normal"},
        {"id": 2, "role": "scatter"}]
    assert cfg["events"] == [{"symbol": 2, "min_count": 3, "emit": SCATTER_EVENT}]
    meter = d["mechanics"][1]
    assert meter == {"id": "meter_2", "type": "meter@1",
                     "config": {"target": 7, "count_symbol": 2,
                                "on_full": "meter2:full", "reset_on_full": True}}
    # states: base + fs_1 + meter_2_bonus
    assert [s["id"] for s in d["states"]] == ["base", "fs_1", "meter_2_bonus"]
    base = d["states"][0]
    assert base["bindings"] == [{"mechanic": "main_reels"}, {"mechanic": "meter_2"}]
    assert base["script"] == [{"invoke": "main_reels.spin"},
                              {"invoke": "meter_2.accumulate"}]
    assert base["steps"] == {"budget": 1}
    fs = d["states"][1]
    assert fs["steps"] == {"budget": "awarded", "initial": 10}
    mb = d["states"][2]
    assert mb["steps"] == {"budget": METER_STATE_BUDGET}
    assert d["transitions"] == [
        {"from": "base", "on": SCATTER_EVENT, "to": "fs_1"},
        {"from": "base", "on": "meter2:full", "to": "meter_2_bonus"},
        {"from": "fs_1", "on": SCATTER_EVENT, "effect": "steps:add:10"},
    ]
    assert res.slot_ids == {"high1": 0, "low1": 1, "scat": 2}


def test_no_features_yields_single_base_state():
    res = _realize(features={})
    d = res.model
    assert [s["id"] for s in d["states"]] == ["base"]
    assert d["transitions"] == []
    assert d["mechanics"][0]["config"]["events"] == []


def test_defaults_for_blank_budget_and_no_retrigger():
    res = _realize(features={"features": [
        {"name": "FS", "trigger": "t", "kind": "free-spins", "budget": ""},
        {"name": "M", "trigger": "t", "kind": "meter", "budget": ""},
    ]})
    d = res.model
    assert d["states"][1]["steps"]["initial"] == DEFAULT_FS_SPINS
    assert d["mechanics"][1]["config"]["target"] == DEFAULT_METER_TARGET
    assert not any("effect" in t for t in d["transitions"])  # no retrigger


def test_blank_kind_defaults_to_free_spins():
    res = _realize(features={"features": [{"name": "FS", "trigger": "t"}]})
    assert res.model["states"][1]["id"] == "fs_1"


def test_features_without_scatter_are_skipped_with_warning():
    symbols = {"symbols": [{"slot": "a", "kind": "high"}]}
    res = _realize(symbols=symbols)
    assert res.model is not None
    assert [s["id"] for s in res.model["states"]] == ["base"]
    assert any("no scatter" in w for w in res.warnings)


def test_second_free_spins_chains_from_first():
    res = _realize(features={"features": [
        {"name": "FS1", "trigger": "t", "kind": "free-spins", "retrigger": "yes"},
        {"name": "FS2", "trigger": "t", "kind": "free-spins", "retrigger": "yes"},
    ]})
    d = res.model
    assert {"from": "base", "on": SCATTER_EVENT, "to": "fs_1"} in d["transitions"]
    assert {"from": "fs_1", "on": SCATTER_EVENT, "to": "fs_2"} in d["transitions"]
    # retrigger only on the LAST fs state (fs_1's scatter event is consumed
    # by the chain transition)
    effects = [t for t in d["transitions"] if "effect" in t]
    assert effects == [{"from": "fs_2", "on": SCATTER_EVENT,
                        "effect": f"steps:add:{DEFAULT_FS_SPINS}"}]
    assert any("chains from" in w for w in res.warnings)


def test_existing_ids_keep_join_keys_stable():
    res = _realize()
    # simulate a later realize where 'low1' was removed: surviving ids keep
    res2 = realize_game_definition(
        _MATH,
        {"symbols": [{"slot": "high1", "kind": "high"},
                     {"slot": "scat", "kind": "scatter"}]},
        _PAYTABLE, _FEATURES, existing_ids={"high1": 0, "low1": 1, "scat": 2})
    assert res2.slot_ids == {"high1": 0, "scat": 2}


def test_no_symbols_is_a_hard_error():
    res = _realize(symbols={"symbols": []})
    assert res.model is None and res.errors
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_realize_composed.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.math.realize_composed'`.

- [ ] **Step 3: Write the implementation** (`studio/backend/app/math/realize_composed.py`)

```python
"""Pure GDD→GameDefinition realizer (SP-D). Structural sibling of realize.py:
compiles the structured GDD aspects into a structurally-valid (numerically
rough) composed@1 GameDefinition dict. Pure: no IO, no RNG. Fail-loud:
RealizeResult.model is None iff a hard structural contradiction was found.
The GA owns the numbers (strips, paytable, budgets, targets) after seeding."""
from app.math.realize import (
    BONUS_MIN_COUNT, DEFAULT_REELS, DEFAULT_ROWS, MAX_REELS, MAX_ROWS,
    RealizeResult, _to_bool, _to_int, realize_paylines, realize_paytable,
    realize_reels, realize_symbols, slot_id_map,
)

SCATTER_EVENT = "scatters:3"
DEFAULT_FS_SPINS = 8       # matches the demo definition's fs1 initial
DEFAULT_METER_TARGET = 6   # matches the demo meter target
METER_STATE_BUDGET = 5     # fixed-budget bonus state a full meter enters
MAX_STEPS = 1000           # matches runtime/server/demo caps


def _kind(row: dict) -> str:
    k = str(row.get("kind", "")).strip().lower()
    return k if k in ("free-spins", "meter") else "free-spins"


def realize_game_definition(
    math_model: dict,
    symbols_reels: dict,
    paytable: dict,
    bonus_features: dict,
    existing_ids: dict[str, int] | None = None,
) -> RealizeResult:
    errors: list[str] = []
    warnings: list[str] = []

    symbol_defs, name_to_id, e, w = realize_symbols(symbols_reels, existing_ids)
    errors += e
    warnings += w
    if not symbol_defs:
        return RealizeResult(None, errors, warnings)

    if math_model.get("reels") in (None, ""):
        warnings.append(f"reels absent; defaulted to {DEFAULT_REELS}")
    reel_count = _to_int(math_model.get("reels"), DEFAULT_REELS)
    if math_model.get("rows") in (None, ""):
        warnings.append(f"rows absent; defaulted to {DEFAULT_ROWS}")
    rows = _to_int(math_model.get("rows"), DEFAULT_ROWS)
    if reel_count > MAX_REELS:
        errors.append(f"reels {reel_count} exceeds MAX_REELS {MAX_REELS}")
    if rows > MAX_ROWS:
        errors.append(f"rows {rows} exceeds MAX_ROWS {MAX_ROWS}")
    if errors:
        return RealizeResult(None, errors, warnings)

    strips, e, w = realize_reels(symbols_reels, symbol_defs, reel_count)
    errors += e
    warnings += w
    paylines, e, w = realize_paylines(math_model, reel_count, rows)
    errors += e
    warnings += w
    paytable_out, e, w = realize_paytable(paytable, name_to_id, symbol_defs)
    errors += e
    warnings += w
    if errors:
        return RealizeResult(None, errors, warnings)

    scatter = next((d["id"] for d in symbol_defs if d["role"] == "scatter"), None)
    feature_rows = list(bonus_features.get("features") or [])
    if feature_rows and scatter is None:
        warnings.append(
            "bonus features defined but no scatter/bonus trigger symbol "
            "exists; features skipped")
        feature_rows = []

    reels_config: dict = {
        "strips": strips, "rows": rows, "symbols": symbol_defs,
        "paylines": paylines, "paytable": paytable_out, "events": [],
    }
    if any(_kind(r) == "free-spins" for r in feature_rows):
        reels_config["events"].append(
            {"symbol": scatter, "min_count": BONUS_MIN_COUNT,
             "emit": SCATTER_EVENT})

    mechanics: list[dict] = [
        {"id": "main_reels", "type": "reels@1", "config": reels_config}]
    base_bindings: list[dict] = [{"mechanic": "main_reels"}]
    base_script: list[dict] = [{"invoke": "main_reels.spin"}]
    states: list[dict] = []
    transitions: list[dict] = []
    last_fs: tuple[str, dict] | None = None  # (state id, feature row)

    for i, row in enumerate(feature_rows, start=1):
        if _kind(row) == "free-spins":
            sid = f"fs_{i}"
            initial = _to_int(row.get("budget"), DEFAULT_FS_SPINS)
            states.append({
                "id": sid,
                "bindings": [{"mechanic": "main_reels"}],
                "steps": {"budget": "awarded", "initial": initial},
                "script": [{"invoke": "main_reels.spin"}],
            })
            # Later free-spins states chain from the previous one: two
            # transitions from the same state on the one scatter event would
            # be ambiguous.
            src = last_fs[0] if last_fs else "base"
            if last_fs:
                warnings.append(
                    f"multiple free-spins features share one scatter event; "
                    f"'{sid}' chains from '{last_fs[0]}' instead of base")
            transitions.append({"from": src, "on": SCATTER_EVENT, "to": sid})
            last_fs = (sid, row)
        else:  # meter
            mid = f"meter_{i}"
            on_full = f"meter{i}:full"  # explicit per-meter event: collision-free
            target = _to_int(row.get("budget"), DEFAULT_METER_TARGET)
            mechanics.append({
                "id": mid, "type": "meter@1",
                "config": {"target": target, "count_symbol": scatter,
                           "on_full": on_full, "reset_on_full": True},
            })
            base_bindings.append({"mechanic": mid})
            base_script.append({"invoke": f"{mid}.accumulate"})
            sid = f"meter_{i}_bonus"
            states.append({
                "id": sid,
                "bindings": [{"mechanic": "main_reels"}],
                "steps": {"budget": METER_STATE_BUDGET},
                "script": [{"invoke": "main_reels.spin"}],
            })
            transitions.append({"from": "base", "on": on_full, "to": sid})

    # Retrigger only on the LAST free-spins state in the chain: any earlier
    # fs state already consumes the scatter event with its chain transition.
    if last_fs is not None and _to_bool(last_fs[1].get("retrigger")):
        initial = _to_int(last_fs[1].get("budget"), DEFAULT_FS_SPINS)
        transitions.append({"from": last_fs[0], "on": SCATTER_EVENT,
                            "effect": f"steps:add:{initial}"})

    base = {"id": "base", "bindings": base_bindings,
            "steps": {"budget": 1}, "script": base_script}
    model = {
        "family": "composed@1",
        "mechanics": mechanics,
        "states": [base] + states,
        "start": "base",
        "transitions": transitions,
        "caps": {"max_steps": MAX_STEPS},
    }
    return RealizeResult(model, errors, warnings,
                         slot_id_map(symbols_reels, name_to_id))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_realize_composed.py -v`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/math/realize_composed.py studio/backend/tests/test_realize_composed.py
git commit -m "feat(math): pure GDD->composed realize_game_definition"
```

---

### Task 4: Composed shape mapping + 3-group merge

**Files:**

- Modify: `studio/backend/app/math/shape.py`
- Test: `studio/backend/tests/test_shape.py` (append)

**Interfaces:**

- Consumes: `SectionLocks` (attrs `reels`/`paytable`/`bonus`).
- Produces: `SHAPE_FIELDS["math-model"]` includes `"game_family"`; `composed_affected_groups(aspect, fields) -> set[str]` over `{"reels","paytable","features"}`; `merge_composed_groups(existing: dict, realized: dict, groups: set[str], locks: SectionLocks) -> dict`. Realizer-side mechanic id is always `main_reels`; merge retargets grafted states/transitions to the existing reels mechanic's id when it differs.

- [ ] **Step 1: Write the failing tests** (append to `studio/backend/tests/test_shape.py`)

```python
from app.math.shape import composed_affected_groups, merge_composed_groups


def _mini_def(reels_id="main_reels", payout=5):
    return {
        "family": "composed@1",
        "mechanics": [{"id": reels_id, "type": "reels@1", "config": {
            "strips": [[0, 1]], "rows": 1, "symbols": [{"id": 0, "role": "normal"}],
            "paylines": [[0]],
            "paytable": {"entries": [{"symbol": 0, "count": 1, "payout": payout}]},
            "events": [],
        }}],
        "states": [{"id": "base", "bindings": [{"mechanic": reels_id}],
                    "steps": {"budget": 1},
                    "script": [{"invoke": f"{reels_id}.spin"}]}],
        "start": "base", "transitions": [], "caps": {"max_steps": 1000},
    }


def test_game_family_is_a_shape_field():
    from app.math.shape import is_shape_change
    assert is_shape_change("math-model", {"game_family": "composed@1"})


def test_composed_affected_groups_mapping():
    assert composed_affected_groups("math-model", {"reels": 4}) == {"reels"}
    assert composed_affected_groups("symbols-reels", {"symbols": []}) == {"reels", "paytable"}
    assert composed_affected_groups("bonus-features", {"features": []}) == {"features"}
    assert composed_affected_groups("math-model", {"game_family": "x"}) == {
        "reels", "paytable", "features"}


def test_merge_grafts_only_requested_unlocked_groups():
    existing = _mini_def(payout=999)   # hand-tuned paytable
    realized = _mini_def(payout=5)
    realized["mechanics"][0]["config"]["strips"] = [[0, 0, 0]]
    out = merge_composed_groups(existing, realized, {"reels"}, SectionLocks())
    assert out["mechanics"][0]["config"]["strips"] == [[0, 0, 0]]      # grafted
    assert out["mechanics"][0]["config"]["paytable"]["entries"][0]["payout"] == 999


def test_merge_honors_locks():
    existing = _mini_def(payout=999)
    realized = _mini_def(payout=5)
    out = merge_composed_groups(existing, realized, {"paytable"},
                                SectionLocks(paytable=True))
    assert out["mechanics"][0]["config"]["paytable"]["entries"][0]["payout"] == 999


def test_features_graft_retargets_to_existing_reels_id():
    existing = _mini_def(reels_id="my_reels")
    realized = _mini_def()  # main_reels
    realized["states"].append({"id": "fs_1",
                               "bindings": [{"mechanic": "main_reels"}],
                               "steps": {"budget": "awarded", "initial": 8},
                               "script": [{"invoke": "main_reels.spin"}]})
    realized["transitions"] = [{"from": "base", "on": "scatters:3", "to": "fs_1"}]
    out = merge_composed_groups(existing, realized, {"features"}, SectionLocks())
    assert out["mechanics"][0]["id"] == "my_reels"                      # kept
    fs = next(s for s in out["states"] if s["id"] == "fs_1")
    assert fs["bindings"] == [{"mechanic": "my_reels"}]                 # retargeted
    assert fs["script"] == [{"invoke": "my_reels.spin"}]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_shape.py -v -k "composed or game_family or graft or retarget"`
Expected: FAIL with `ImportError` (no `composed_affected_groups`).

- [ ] **Step 3: Implement** (append to `studio/backend/app/math/shape.py`; also add `"game_family"` to `SHAPE_FIELDS["math-model"]` and `import copy` at the top)

```python
SHAPE_FIELDS: dict[str, set[str]] = {
    "math-model": {"reels", "rows", "payline_mode", "payline_count", "game_family"},
    "symbols-reels": {"symbols", "strip_length"},
    "bonus-features": {"features"},
}
```

```python
# ── composed@1: 3-group merge (SP-D). Groups mirror the tuner's lock groups.
COMPOSED_GROUP_FIELDS: dict[tuple[str, str], set[str]] = {
    ("math-model", "reels"): {"reels"},
    ("math-model", "rows"): {"reels"},
    ("math-model", "payline_mode"): {"reels"},
    ("math-model", "payline_count"): {"reels"},
    ("math-model", "game_family"): {"reels", "paytable", "features"},
    ("symbols-reels", "symbols"): {"reels", "paytable"},
    ("symbols-reels", "strip_length"): {"reels"},
    ("bonus-features", "features"): {"features"},
}

_GROUP_LOCK_ATTR = {"reels": "reels", "paytable": "paytable", "features": "bonus"}


def composed_affected_groups(aspect: str, fields: dict) -> set[str]:
    out: set[str] = set()
    for key in fields:
        out |= COMPOSED_GROUP_FIELDS.get((aspect, key), set())
    return out


def _first_reels(definition: dict) -> dict | None:
    return next((m for m in definition.get("mechanics") or []
                 if m.get("type") == "reels@1"), None)


def _retarget(obj, old: str, new: str):
    """Rewrite mechanic references (bindings + script invokes) old -> new."""
    if isinstance(obj, list):
        return [_retarget(x, old, new) for x in obj]
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k == "mechanic" and v == old:
                out[k] = new
            elif k == "invoke" and isinstance(v, str) and v.startswith(old + "."):
                out[k] = new + v[len(old):]
            else:
                out[k] = _retarget(v, old, new)
        return out
    return obj


def merge_composed_groups(existing: dict, realized: dict, groups: set[str],
                          locks: SectionLocks) -> dict:
    unlocked = {g for g in groups if not getattr(locks, _GROUP_LOCK_ATTR[g])}
    out = copy.deepcopy(existing)
    re_reels = _first_reels(realized)  # realizer always emits main_reels
    ex_reels = _first_reels(out)
    if ex_reels is None:
        out.setdefault("mechanics", []).insert(0, copy.deepcopy(re_reels))
        ex_reels = _first_reels(out)
    reels_id = ex_reels["id"]
    if "reels" in unlocked:
        for key in ("strips", "rows", "symbols", "paylines"):
            ex_reels["config"][key] = copy.deepcopy(re_reels["config"][key])
    if "paytable" in unlocked:
        ex_reels["config"]["paytable"] = copy.deepcopy(re_reels["config"]["paytable"])
    if "features" in unlocked:
        ex_reels["config"]["events"] = copy.deepcopy(re_reels["config"].get("events", []))
        meters = [m for m in realized.get("mechanics") or []
                  if m.get("type") == "meter@1"]
        out["mechanics"] = [ex_reels] + copy.deepcopy(meters)
        for key in ("states", "transitions", "start", "caps"):
            out[key] = copy.deepcopy(realized[key])
        if reels_id != "main_reels":
            out["states"] = _retarget(out["states"], "main_reels", reels_id)
            out["transitions"] = _retarget(out["transitions"], "main_reels", reels_id)
    out["family"] = "composed@1"
    return out
```

Make sure `studio/backend/tests/test_shape.py` imports `SectionLocks` at the top (`from app.math.models import SectionLocks`) — the new tests construct it; add the import if the file doesn't already have it.

- [ ] **Step 4: Run the shape tests**

Run: `uv --directory studio/backend run pytest tests/test_shape.py -v`
Expected: PASS (all pre-existing + 5 new).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/math/shape.py studio/backend/tests/test_shape.py
git commit -m "feat(math): composed 3-group shape mapping + merge with lock/retarget rules"
```

---

### Task 5: Doc + store lifecycle — `origin`/`shape_stale` for composed

**Files:**

- Modify: `studio/backend/app/compose/models.py`
- Modify: `studio/backend/app/compose/store.py:85-107`
- Modify: `studio/backend/app/math/store.py` (`_composed_view`, `save_realized`, `set_stale_flags`)
- Test: `studio/backend/tests/test_math_store.py` (append)

**Interfaces:**

- Consumes: `ComposeStore.put(game_id, *, definition, presentation, source)`.
- Produces: `GameDefinitionDoc.origin: Literal["template","realized"] = "template"`, `GameDefinitionDoc.shape_stale: bool = False`; `ComposeStore.put(source="realize")` writes a definition WITHOUT setting `touched`; `MathStore._composed_view` maps `origin`/`shape_stale`/`touched` from the compose doc (no more hardcoding); `MathStore.save_realized` works for composed (writes through `ComposeStore.put(source="realize")`, stamps `origin="realized"`, clears `shape_stale`, sets `verdict_stale` when results exist); `MathStore.set_stale_flags` persists `shape_stale` for composed.

- [ ] **Step 1: Write the failing tests** (append to `studio/backend/tests/test_math_store.py`; the file already has a `mongo_db` fixture pattern — reuse its imports)

```python
from app.compose.store import ComposeStore


def _composed_stores(mongo_db):
    compose = ComposeStore(mongo_db)
    class _Gdd:
        async def get_doc(self, game_id, aspect):
            from types import SimpleNamespace
            return SimpleNamespace(data={"game_family": "composed@1"})
    return MathStore(mongo_db, compose_store=compose, gdd_store=_Gdd()), compose


async def test_composed_save_realized_writes_through_compose_without_touched(mongo_db):
    store, compose = _composed_stores(mongo_db)
    model = {"family": "composed@1", "mechanics": [], "states": [], "start": "base",
             "transitions": [], "caps": {"max_steps": 1000}}
    doc = await store.save_realized("cg1", model)
    assert doc.model == model
    assert doc.origin == "realized" and doc.shape_stale is False
    cdoc = await compose.get("cg1")
    assert cdoc.touched is False          # realize is not an authored write
    assert cdoc.origin == "realized"


async def test_composed_save_realized_marks_verdict_stale_when_results_exist(mongo_db):
    store, compose = _composed_stores(mongo_db)
    await store.get_or_seed("cg2")
    await compose._docs.update_one(
        {"game_id": "cg2"},
        {"$set": {"result": {"status": "pass", "ranAt": "t",
                             "metrics": {"rtp": 1.0, "volatility": 1.0,
                                         "hitFrequency": 0.1, "baseRtp": 1.0,
                                         "featureRtp": 0.0, "bonusHitRates": []}}}})
    doc = await store.save_realized("cg2", {"family": "composed@1"})
    assert doc.verdict_stale is True


async def test_composed_set_stale_flags_persists_shape_stale(mongo_db):
    store, _ = _composed_stores(mongo_db)
    await store.get_or_seed("cg3")
    doc = await store.set_stale_flags("cg3", shape_stale=True)
    assert doc.shape_stale is True
    doc = await store.set_stale_flags("cg3", shape_stale=False)
    assert doc.shape_stale is False


async def test_composed_view_maps_touched_from_compose_doc(mongo_db):
    store, compose = _composed_stores(mongo_db)
    doc = await store.get_or_seed("cg4")     # bare seed
    assert doc.touched is False
    await compose.put("cg4", definition={"family": "composed@1"}, source="api")
    doc = await store.get("cg4")
    assert doc.touched is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_math_store.py -v -k composed`
Expected: FAIL — `save_realized` raises `RuntimeError("composed realize arrives with SP-D")`; the view test fails on hardcoded `touched=True`.

- [ ] **Step 3: Implement**

`studio/backend/app/compose/models.py` — add to `GameDefinitionDoc` (after `touched`), plus `from typing import Literal` at the top:

```python
    # SP-D realize lifecycle (mirrors SlotModelDoc)
    origin: Literal["template", "realized"] = "template"
    shape_stale: bool = False   # GDD shape != definition (gated re-realize denied)
```

`studio/backend/app/compose/store.py` — in `put`, replace the definition branch:

```python
        if definition is not None:
            fields["definition"] = definition
            if source != "realize":
                # a deliberate authored write — see GameDefinitionDoc.touched;
                # realize seeds/reshapes without claiming authorship (slots parity)
                fields["touched"] = True
```

`studio/backend/app/math/store.py` — `_composed_view` maps the real flags:

```python
        return SlotModelDoc(
            id=cdoc.id, game_id=cdoc.game_id, model=cdoc.definition,
            params=cdoc.params, tuner_params=cdoc.tuner_params, locks=cdoc.locks,
            presentation=cdoc.presentation, origin=cdoc.origin,
            touched=cdoc.touched,
            verdict_stale=cdoc.verdict_stale, shape_stale=cdoc.shape_stale,
            result=cdoc.result, tune_result=cdoc.tune_result,
            created_at=cdoc.created_at, updated_at=cdoc.updated_at,
        )
```

`save_realized` — replace the composed guard:

```python
        if await self.family(game_id) == "composed@1":
            existing = await self.get_or_seed(game_id)
            await self._compose.put(game_id, definition=model, source="realize")
            fields = {"origin": "realized", "shape_stale": False,
                      "updated_at": _now()}
            if existing.result is not None or existing.tune_result is not None:
                fields["verdict_stale"] = True
            await self._compose._docs.update_one({"game_id": game_id},
                                                 {"$set": fields})
            return await self.get(game_id)
```

`set_stale_flags` composed branch — persist `shape_stale` (replace the comment + drop):

```python
            if verdict_stale is not None:
                fields["verdict_stale"] = verdict_stale
            if shape_stale is not None:
                fields["shape_stale"] = shape_stale
```

- [ ] **Step 4: Run store + compose tests**

Run: `uv --directory studio/backend run pytest tests/test_math_store.py tests/test_math_descriptor.py tests/test_compose_store.py -v` (if `tests/test_compose_store.py` doesn't exist, drop it from the command — `grep -l "ComposeStore" studio/backend/tests/*.py` to find the compose store's test file and include that instead)
Expected: PASS. **Watch for**: `_composed_view` mapping `touched` may break an SP-C test that asserted `touched is True` for composed views — if one fails, read it: the new mapping is the spec'd behavior, update the stale assertion.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/compose/models.py studio/backend/app/compose/store.py studio/backend/app/math/store.py studio/backend/tests/test_math_store.py
git commit -m "feat(math): composed realize lifecycle on GameDefinitionDoc (origin/shape_stale/touched)"
```

---

### Task 6: Family dispatch in `realize_flow.realize_game`

**Files:**

- Modify: `studio/backend/app/math/realize_flow.py`
- Test: `studio/backend/tests/test_realize_flow.py` (append + fixture widening)

**Interfaces:**

- Consumes: Task 3 `realize_game_definition`, Task 4 `composed_affected_groups` / `merge_composed_groups`, Task 5 store behavior.
- Produces: `realize_game(...)` (signature unchanged) realizes either family; composed uses 3-group merge with `{"reels","paytable","features"}` as the all-groups set; join-key write-back identical for both families.

- [ ] **Step 1: Widen the fixtures and write the failing tests** (in `studio/backend/tests/test_realize_flow.py`)

Replace the `math_store` fixture so `family()` can resolve (back-compatible — existing slots tests never set `game_family` and have no touched compose doc, so they still resolve slots@1):

```python
from app.compose.store import ComposeStore


@pytest.fixture
def compose_store(mongo_db):
    return ComposeStore(mongo_db)


@pytest.fixture
def math_store(mongo_db, gdd_store, compose_store):
    return MathStore(mongo_db, compose_store=compose_store, gdd_store=gdd_store)
```

(`gdd_store` fixture already exists; move it above `math_store` if needed.) Then append:

```python
COMPOSED_GDD = {
    "math-model": {"reels": 3, "rows": 3, "payline_count": 3,
                   "game_family": "composed@1"},
    "symbols-reels": {"symbols": [
        {"slot": "a", "kind": "high"}, {"slot": "b", "kind": "low"},
        {"slot": "scat", "kind": "scatter"},
    ]},
    "paytable": {},
    "bonus-features": {"features": [
        {"name": "FS", "trigger": "3 scat", "kind": "free-spins"}]},
}


async def test_composed_birth_realizes_definition_and_join_keys(
    math_store, gdd_store, compose_store
):
    await _seed_gdd(gdd_store, "cf1", COMPOSED_GDD)
    res = await realize_game(math_store, gdd_store, "cf1")
    assert res.realized
    doc = await math_store.get("cf1")
    assert doc.origin == "realized"
    assert doc.model["family"] == "composed@1"
    assert [s["id"] for s in doc.model["states"]] == ["base", "fs_1"]
    sym_doc = await gdd_store.get_doc("cf1", "symbols-reels")
    assert [r["model_id"] for r in sym_doc.data["symbols"]] == [0, 1, 2]
    cdoc = await compose_store.get("cf1")
    assert cdoc.touched is False          # realize does not claim authorship


async def test_composed_sectional_rerealize_preserves_tuned_paytable(
    math_store, gdd_store
):
    await _seed_gdd(gdd_store, "cf2", COMPOSED_GDD)
    await realize_game(math_store, gdd_store, "cf2")
    before = await math_store.get("cf2")
    tuned = dict(before.model)
    tuned["mechanics"][0]["config"]["paytable"] = {
        "entries": [{"symbol": 0, "count": 3, "payout": 777}]}
    await math_store.put("cf2", model=tuned, source="tuner")
    await gdd_store.set_fields("cf2", "math-model", {"reels": 4})
    res = await realize_game(math_store, gdd_store, "cf2",
                             aspect="math-model", fields={"reels": 4})
    assert res.realized
    doc = await math_store.get("cf2")
    cfg = doc.model["mechanics"][0]["config"]
    assert len(cfg["strips"]) == 4                                   # rebuilt
    assert cfg["paytable"]["entries"][0]["payout"] == 777            # preserved


async def test_family_flip_realizes_new_family_and_leaves_old_artifact_inert(
    math_store, gdd_store, compose_store, mongo_db
):
    # A touched slots game flips to composed@1: the hook realizes the NEW
    # family's artifact (fresh, untouched -> no consent needed); the slots doc
    # stays in its collection, inert (reversible by flipping back).
    from types import SimpleNamespace
    from app.math.realize_flow import apply_math_hooks
    await _seed_gdd(gdd_store, "cf4")                       # slots GDD (module fixture)
    await realize_game(math_store, gdd_store, "cf4")
    await math_store.put("cf4", model=(await math_store.get("cf4")).model,
                         source="editor")                   # touched slots artifact
    slots_before = (await mongo_db["slot_models"].find_one({"game_id": "cf4"}))["model"]

    await gdd_store.set_fields("cf4", "math-model",
                               {"game_family": "composed@1"})
    app_state = SimpleNamespace(math_store=math_store, gdd_store=gdd_store,
                                gdd_hub=None)
    result = await apply_math_hooks(app_state, "cf4", "math-model",
                                    {"game_family": "composed@1"})

    assert result == "applied"
    cdoc = await compose_store.get("cf4")
    assert cdoc.definition["family"] == "composed@1"
    assert cdoc.origin == "realized"
    slots_after = (await mongo_db["slot_models"].find_one({"game_id": "cf4"}))["model"]
    assert slots_after == slots_before                      # old artifact untouched


async def test_composed_explicit_realize_honors_locks(math_store, gdd_store):
    await _seed_gdd(gdd_store, "cf3", COMPOSED_GDD)
    await realize_game(math_store, gdd_store, "cf3")
    before = await math_store.get("cf3")
    tuned = dict(before.model)
    tuned["mechanics"][0]["config"]["paytable"] = {
        "entries": [{"symbol": 0, "count": 3, "payout": 999}]}
    await math_store.put("cf3", model=tuned,
                         locks=SectionLocks(paytable=True), source="editor")
    res = await realize_game(math_store, gdd_store, "cf3")
    assert res.realized
    doc = await math_store.get("cf3")
    cfg = doc.model["mechanics"][0]["config"]
    assert cfg["paytable"]["entries"][0]["payout"] == 999            # locked: kept
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_realize_flow.py -v`
Expected: the 3 new tests FAIL (composed path realizes a slots model / store raises before Task 5 — after Task 5, they fail on the slots-shaped `result.model`); all pre-existing tests still PASS.

- [ ] **Step 3: Implement the dispatch** (`studio/backend/app/math/realize_flow.py`)

Replace the imports and the head of `realize_game`:

```python
from app.math.realize import realize_slot_model
from app.math.realize_composed import realize_game_definition
from app.math.shape import (
    affected_sections, composed_affected_groups, merge_composed_groups,
    merge_sections,
)
```

```python
async def realize_game(math_store, gdd_store, game_id: str, *,
                       aspect: str | None = None,
                       fields: dict | None = None,
                       gdd_hub=None) -> RealizeFlowResult:
    data = {}
    for a in _ASPECTS:
        doc = await gdd_store.get_doc(game_id, a)
        data[a] = dict(doc.data) if doc else {}

    family = await math_store.family(game_id)
    args = (data["math-model"], data["symbols-reels"], data["paytable"],
            data["bonus-features"])
    existing_ids = _existing_ids(data["symbols-reels"])
    if family == "composed@1":
        result = realize_game_definition(*args, existing_ids=existing_ids)
    else:
        result = realize_slot_model(*args, existing_ids=existing_ids)
    if result.model is None:
        return RealizeFlowResult(False, result.errors, result.warnings)

    existing = await math_store.get_or_seed(game_id)
    # Always merge, honoring locks (see the slots rationale below); a first
    # realize from a template base covers all sections/groups.
    if family == "composed@1":
        groups = (composed_affected_groups(aspect, fields or {})
                  if aspect and existing.origin != "template"
                  else {"reels", "paytable", "features"})
        model = merge_composed_groups(existing.model, result.model, groups,
                                      existing.locks)
    else:
        sections = (affected_sections(aspect, fields or {})
                    if aspect and existing.origin != "template"
                    else {"symbols", "reels", "paylines", "paytable", "bonuses"})
        model = merge_sections(existing.model, result.model, sections,
                               existing.locks)
    await math_store.save_realized(game_id, model)
```

(The join-key write-back block below stays byte-identical — `result.slot_ids` exists for both families.) Keep the existing explanatory comment about template-origin merges with the slots branch.

- [ ] **Step 4: Run the flow + agent-tool tests**

Run: `uv --directory studio/backend run pytest tests/test_realize_flow.py tests/test_agent_tools.py -v`
Expected: PASS (agent tools route through the same `realize_game`; their slots tests must stay green).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/math/realize_flow.py studio/backend/tests/test_realize_flow.py
git commit -m "feat(math): family dispatch in realize_game with composed 3-group merge"
```

---

### Task 7: Composed targets get pay constraints; `is_composed` goes public

**Files:**

- Modify: `studio/backend/app/math/target_flow.py`
- Modify: `studio/backend/app/agent_tools.py:24` (+ 2 call sites `_is_composed(` → `is_composed(`)
- Test: `studio/backend/tests/test_target_flow.py` (append)

**Interfaces:**

- Produces: `is_composed(model: dict) -> bool` (public; `_is_composed` deleted); composed `derive_target_for` passes `paytable_data`/`symbols_data` so `pay_constraints` compile via the `model_id` join keys. Bonus-rate bands remain excluded for composed (`num_bonuses=0`).

- [ ] **Step 1: Write the failing test** (append to `studio/backend/tests/test_target_flow.py`; mirror the file's existing fake-store pattern — it stubs `gdd_store.get_doc` with `SimpleNamespace(data=...)` per aspect and builds a doc via `SlotModelDoc`/`SimpleNamespace`; follow whichever it already uses)

```python
async def test_composed_target_compiles_pay_constraints_from_join_keys():
    data = {
        "math-model": {"rtp": 0.96, "volatility": "low"},
        "paytable": {"pay_constraints": [
            {"symbol": "high1", "relation": "top-paying"}]},
        "symbols-reels": {"symbols": [
            {"slot": "high1", "kind": "high", "model_id": 0},
            {"slot": "scat", "kind": "scatter", "model_id": 2}]},
        "bonus-features": {"features": [{"name": "FS", "trigger": "t"}]},
    }

    class _Gdd:
        async def get_doc(self, game_id, aspect):
            return SimpleNamespace(data=data.get(aspect, {}))

    doc = SimpleNamespace(model={"family": "composed@1"},
                          params=default_params())
    target = await derive_target_for(_Gdd(), "g", doc)
    assert target["pay_constraints"] == [{"symbol": 0, "relation": "top-paying"}]
    assert target["bonus_hit_rate_bands"] == []   # composed: no bonus bands
```

(Add `from types import SimpleNamespace` / `from app.math.models import default_params` to the file's imports if not already present.)

- [ ] **Step 2: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_target_flow.py -v`
Expected: the new test FAILS (`pay_constraints` missing from the composed target).

- [ ] **Step 3: Implement** (`studio/backend/app/math/target_flow.py`)

```python
def is_composed(model: dict) -> bool:
    return (model or {}).get("family") == "composed@1"
```

(delete `_is_composed`; update the two internal uses) and in `derive_target_for` replace the composed branch:

```python
    if is_composed(model):
        # Bonus bands stay slots-typed (#160 owns feature bands); pay
        # constraints compile via the model_id join keys the composed
        # realizer stamps (SP-D).
        return derive_target(math_model, doc.params, 0,
                             paytable_data=await data("paytable"),
                             symbols_data=await data("symbols-reels"))
```

In `studio/backend/app/agent_tools.py` line 24: `from app.math.target_flow import derive_target_for, is_composed`, and rename the two call sites (`agent_tools.py:1331`, `agent_tools.py:1350`).

- [ ] **Step 4: Run target + agent + tuner-tool tests**

Run: `uv --directory studio/backend run pytest tests/test_target_flow.py tests/test_agent_tools.py tests/test_tuner_tools.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/math/target_flow.py studio/backend/app/agent_tools.py studio/backend/tests/test_target_flow.py
git commit -m "feat(math): composed targets compile pay constraints; is_composed public"
```

---

### Task 8: Remove the composed realize REST guard

**Files:**

- Modify: `studio/backend/app/math/rest.py:50-60`
- Test: `studio/backend/tests/test_math_rest.py` (append)

**Interfaces:**

- Consumes: everything above. `POST /games/{id}/slot-model/realize` now realizes both families.

- [ ] **Step 1: Write the failing test** (append to `studio/backend/tests/test_math_rest.py`)

```python
@pytest.mark.asyncio
async def test_realize_endpoint_dispatches_composed(mongo_db):
    from app.compose.store import ComposeStore
    from app.gdd.store import GddStore
    gdd = GddStore(mongo_db)
    compose = ComposeStore(mongo_db)
    store = MathStore(mongo_db, compose_store=compose, gdd_store=gdd)
    await gdd.seed_taxonomy("rest-c1")
    await gdd.set_fields("rest-c1", "math-model", {"game_family": "composed@1"})
    await gdd.set_fields("rest-c1", "symbols-reels", {"symbols": [
        {"slot": "a", "kind": "high"}, {"slot": "scat", "kind": "scatter"}]})
    req = _req(math_store=store, gdd_store=gdd, gdd_hub=None)
    out = await rest.realize_slot_model_rest("rest-c1", req)
    assert out["realized"] is True
    cdoc = await compose.get("rest-c1")
    assert cdoc.definition["family"] == "composed@1"
    assert any(s["id"] == "base" for s in cdoc.definition["states"])
```

(If `GddStore.seed_taxonomy` has a different name, check `tests/test_realize_flow.py:32` — it's the one used there.)

- [ ] **Step 2: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_math_rest.py -v -k composed`
Expected: FAIL with `HTTPException` 409 ("arrives with SP-D").

- [ ] **Step 3: Remove the guard** (`studio/backend/app/math/rest.py`)

Delete these three lines from `realize_slot_model_rest`:

```python
    if await request.app.state.math_store.family(game_id) == "composed@1":
        raise HTTPException(status_code=409,
                            detail="this is a composed@1 game — the composed realizer arrives with SP-D")
```

(Leave the `apply-template` 409 alone — templates stay slots-only.)

- [ ] **Step 4: Run the REST tests + full backend suite**

Run: `uv --directory studio/backend run pytest -q`
Expected: PASS across the whole backend suite. Grep for leftovers: `grep -rn "arrives with SP-D" studio/backend/` must return nothing (the store guard went in Task 5; this was the last one).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/math/rest.py studio/backend/tests/test_math_rest.py
git commit -m "feat(math): composed realize reachable over REST (SP-D guard out)"
```

---

### Task 9: Playwright e2e — GDD-declared composed game, end to end

**Files:**

- Create: `studio/frontend/e2e/gdd-composed-realize.spec.ts`

**Interfaces:**

- Consumes: REST routes `POST /rooms`, `PUT /games/{id}/gdd/{aspect}` (`{fields}` body), `POST /games/{id}/slot-model/realize`, `GET /games/{id}/game-definition`; testids `gs-state-card-<id>` (game-structure), `target-chip-pay-0` (math pane), menu testids `menu-view` / `view-open-game-structure/editor` / `view-open-math/viewer`.

- [ ] **Step 1: Write the spec**

```typescript
import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage, BACKEND_URL as BACKEND } from './helpers';

// SP-D: a GDD that declares game_family composed@1 + structured feature rows
// realizes into a seeded GameDefinition (states/transitions/mechanics + the
// model_id join-key write-back), visible in game-structure, with the composed
// pay constraint compiled into the math pane's target chips.

async function enterRoom(page: Page, username: string, roomName: string): Promise<void> {
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await expect(page.getByTestId('room-picker')).toBeVisible();
  await page.getByTestId('room-picker').getByText(roomName, { exact: true }).click();
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
}

test('GDD-declared composed game realizes: states in game-structure, constraint chips in math', async ({ page, request }) => {
  const roomName = `sp-d realize ${Date.now()}`;
  const resp = await request.post(`${BACKEND}/rooms`, { data: { name: roomName } });
  expect(resp.ok()).toBeTruthy();
  const room = (await resp.json()) as { id: string; gameId: string };
  const g = room.gameId;

  // GDD intent: composed family + one free-spins + one meter feature.
  const mm = await request.put(`${BACKEND}/games/${g}/gdd/math-model`, {
    data: { fields: { game_family: 'composed@1', rtp: '96%', volatility: 'low', reels: 3, rows: 3, payline_count: 3 } },
  });
  expect(mm.ok()).toBeTruthy();
  const sr = await request.put(`${BACKEND}/games/${g}/gdd/symbols-reels`, {
    data: {
      fields: {
        symbols: [
          { slot: 'high1', name: 'Dragon', kind: 'high' },
          { slot: 'low1', name: 'Ten', kind: 'low' },
          { slot: 'scat', name: 'Coin', kind: 'scatter' },
        ],
      },
    },
  });
  expect(sr.ok()).toBeTruthy();
  const bf = await request.put(`${BACKEND}/games/${g}/gdd/bonus-features`, {
    data: {
      fields: {
        features: [
          { name: 'Free Spins', trigger: '3 scatters', description: '', kind: 'free-spins', retrigger: 'yes', budget: 8 },
          { name: 'Coin Meter', trigger: 'meter fills', description: '', kind: 'meter', budget: 6 },
        ],
      },
    },
  });
  expect(bf.ok()).toBeTruthy();

  // Realize: seeds the definition + writes the model_id join keys back.
  const realize = await request.post(`${BACKEND}/games/${g}/slot-model/realize`);
  expect(realize.ok()).toBeTruthy();
  expect(((await realize.json()) as { realized: boolean }).realized).toBe(true);

  const defWire = (await (await request.get(`${BACKEND}/games/${g}/game-definition`)).json()) as {
    definition: { family: string; states: { id: string }[] };
  };
  expect(defWire.definition.family).toBe('composed@1');
  expect(defWire.definition.states.map((s) => s.id)).toEqual(['base', 'fs_1', 'meter_2_bonus']);

  // Pay constraint AFTER realize (it resolves via the just-written join keys).
  const pc = await request.put(`${BACKEND}/games/${g}/gdd/paytable`, {
    data: { fields: { pay_constraints: [{ symbol: 'high1', relation: 'top-paying', count: '', value: '' }] } },
  });
  expect(pc.ok()).toBeTruthy();

  await enterRoom(page, 'sp-d-user', roomName);

  // game-structure renders the realized states.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-game-structure/editor').click();
  await expect(page.getByTestId('gs-state-card-fs_1')).toBeVisible();
  await expect(page.getByTestId('gs-state-card-meter_2_bonus')).toBeVisible();

  // math pane compiles the composed pay constraint into the target chips.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-math/viewer').click();
  await expect(page.getByTestId('target-chip-pay-0')).toBeVisible();
  await expect(page.getByTestId('target-chip-pay-0')).toContainText('top-paying');
});
```

Before running, verify the chip's rendered text in `studio/frontend/src/plugins/math/components/TargetStrip.tsx:77` — if it prints the relation differently (e.g. abbreviated), adjust the `toContainText` to match what it actually renders.

- [ ] **Step 2: Run prettier + the new spec against the replay backend**

From the worktree root (offset 1 — NEVER :8000/:4200):

```bash
node_modules/.bin/prettier --write studio/frontend/e2e/gdd-composed-realize.spec.ts
just backend-serve-replay   # in a background shell; serves :8001
cd studio/frontend && npx playwright test e2e/gdd-composed-realize.spec.ts
```

Expected: 1 passed. (Playwright config reads `BLOOM_PORT_OFFSET` from the worktree `.env`; global-setup fails fast if :8001 has no backend.)

- [ ] **Step 3: Commit**

```bash
git add studio/frontend/e2e/gdd-composed-realize.spec.ts
git commit -m "test(e2e): GDD-declared composed game realize flow"
```

---

### Task 10: Full gates

**Files:** none (verification only; fix anything that falls out, committing per fix).

- [ ] **Step 1: Backend suite**

Run: `uv --directory studio/backend run pytest -q`
Expected: all green.

- [ ] **Step 2: Frontend gates** (all four — vitest green ≠ types valid)

```bash
node_modules/.bin/prettier --check .
npx nx run-many -t typecheck test build
```

Expected: all green. (Known pre-existing: 3 port-hardcoded game-plugin tests fail in offset≠0 worktrees under `nx run-many -t test` — if exactly those fail, note it and move on; they are not this branch's.)

- [ ] **Step 3: Full e2e suite** (replay backend on :8001 still up)

Run: `just e2e`
Expected: suite green (including the new spec and the existing `composed-math.spec.ts`, `gdd.spec.ts`, `gdd-ownership.spec.ts`, `game-structure.spec.ts` neighbors).

- [ ] **Step 4: Push + PR**

```bash
git push -u origin feat/sp-d-realizer
gh pr create --title "feat(math): SP-D GDD->composed realizer" --body "..."
```

PR body: summarize spec §1 decisions + what landed per task; link the spec and umbrella (#164); note follow-ups untouched (#160, #182). End with the standard generated-with footer.

---

## Out of scope (do not build)

- Feature-level tuner bands (#160) — budgets/targets are seeds only.
- Structural GA mutation; visual editors in game-structure (#182).
- Line/shape constraints (#161); prose constraints (#163).
- Any slots@1 behavior change beyond the helper rename (Task 2).

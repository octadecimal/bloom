# GDD→SlotModel realizer (SP2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pure, deterministic Python compiler that turns the structured GDD math fields into a structurally-valid (numerically rough) `SlotModel` dict the Rust kernel accepts.

**Architecture:** A single pure module `studio/backend/app/simulator/realize.py`, the structural sibling of `targets.py`. It is composed of one small helper per `SlotModel` field (symbols, reels, paylines, paytable, bonuses), each returning `(value, errors, warnings)`, plus a top-level `realize_slot_model` that threads the symbol id-map through them and aggregates diagnostics into a `RealizeResult`. Correctness is pinned by golden-vector unit tests and by a parity-oracle test that runs a realized model through the real simulator binary.

**Tech Stack:** Python 3.12, pytest, `uv` for the backend; the existing `SubprocessCurationRunner` (simulator binary harness) for the parity test.

## Global Constraints

- **Pure and deterministic.** `realize.py` does no IO and uses no RNG, so golden vectors pin it exactly.
- **Fail-loud contract.** `realize_slot_model` returns `RealizeResult(model, errors, warnings)`. A non-`None` `model` is structurally valid; hard contradictions yield `model=None` + `errors`; auto-fixable issues set the model + append a `warning`. (This deliberately differs from SP1's coerce-never-raise normalizers.)
- **Exact serde spelling (authoritative, do not vary):** `SymbolRole` serializes **lowercase**: `"normal"`, `"wild"`, `"scatter"`. `SymbolDef` = `{"id": int, "role": str}`. `PaytableEntry` = `{"symbol": int, "count": int, "payout": int}`. `Paytable` = `{"entries": [...]}`. `TriggerSpec` = `{"symbol": int, "min_count": int}`. `FreeSpinsConfig` = `{"spins_awarded": int, "retrigger": bool, "multiplier": int, "feature_reels": None}`. `BonusFeature` is **externally tagged**: `{"FreeSpins": {"trigger": {...}, "config": {...}}}`. `SlotModel` = `{"symbols", "reels", "rows", "paylines", "paytable", "bonuses"}`.
- **`kind → role` map (per the spec):** `wild→wild`, `scatter→scatter`, `bonus→scatter`, `high→normal`, `low→normal`.
- **No Rust, no frontend, no schema change, no wiring.** SP2 is the function + its tests only.
- **Run commands from the worktree root** (`C:\code\bloom.wt\gdd-realizer`). Unit tests: `uv --directory studio/backend run pytest tests/test_realize.py -v`. Parity test (needs cargo): `uv --directory studio/backend run pytest tests/e2e/test_realize_parity.py -v -m e2e`.
- **Prettier gate is repo-wide** but SP2 touches only `.py`; no markdown to format beyond this plan/spec (already formatted with the pinned prettier).

---

## File Structure

- `studio/backend/app/simulator/realize.py` — **create.** The whole realizer: constants, `_KIND_TO_ROLE`, `_to_int`/`_to_bool`, `RealizeResult`, the five `_realize_*` helpers, the unified payline generator `_all_patterns`, and `realize_slot_model`.
- `studio/backend/tests/test_realize.py` — **create.** Unit tests: per-helper behavior, diagnostics, and the full golden vector.
- `studio/backend/tests/e2e/test_realize_parity.py` — **create.** The parity-oracle test against the real simulator binary.

---

### Task 1: Module skeleton — constants, role map, scalar coercers, `RealizeResult`, symbol realization

**Files:**

- Create: `studio/backend/app/simulator/realize.py`
- Test: `studio/backend/tests/test_realize.py`

**Interfaces:**

- Consumes: nothing (first task).
- Produces:
  - Constants `MAX_PAYLINES=4096`, `DEFAULT_STRIP_LEN=30`, `DEFAULT_REELS=5`, `DEFAULT_ROWS=3`, `BONUS_MIN_COUNT=3`.
  - `_KIND_TO_ROLE: dict[str, str]`.
  - `_to_int(raw, default: int) -> int`, `_to_bool(raw) -> bool`.
  - `RealizeResult` dataclass `(model: dict | None, errors: list[str], warnings: list[str])`.
  - `_realize_symbols(symbols_reels: dict) -> tuple[list[dict], dict[str, int], list[str], list[str]]` returning `(symbol_defs, name_to_id, errors, warnings)`. `name_to_id` maps both lowercased `slot` and `name` to the id. Empty symbol set → one error, empty defs.

- [ ] **Step 1: Write the failing tests**

Create `studio/backend/tests/test_realize.py`:

```python
from app.simulator.realize import (
    RealizeResult, _realize_symbols, _to_int, _to_bool, _KIND_TO_ROLE,
)


def test_kind_to_role_map():
    assert _KIND_TO_ROLE == {
        "wild": "wild", "scatter": "scatter", "bonus": "scatter",
        "high": "normal", "low": "normal",
    }


def test_to_int_and_to_bool():
    assert _to_int("10", 0) == 10
    assert _to_int("", 5) == 5
    assert _to_int(None, 5) == 5
    assert _to_int("nope", 7) == 7
    assert _to_bool("yes") is True
    assert _to_bool("TRUE") is True
    assert _to_bool("no") is False
    assert _to_bool("") is False


def test_realize_symbols_assigns_ids_roles_and_name_map():
    sr = {"symbols": [
        {"slot": "high1", "name": "Dragon", "kind": "high"},
        {"slot": "low1", "name": "Ten", "kind": "low"},
        {"slot": "wild", "name": "Rune", "kind": "wild"},
        {"slot": "scatter", "name": "Coin", "kind": "scatter"},
        {"slot": "bonusx", "name": "Chest", "kind": "bonus"},
    ]}
    defs, name_to_id, errors, warnings = _realize_symbols(sr)
    assert errors == []
    assert defs == [
        {"id": 0, "role": "normal"}, {"id": 1, "role": "normal"},
        {"id": 2, "role": "wild"}, {"id": 3, "role": "scatter"},
        {"id": 4, "role": "scatter"},  # bonus -> scatter
    ]
    assert name_to_id["high1"] == 0 and name_to_id["dragon"] == 0
    assert name_to_id["coin"] == 3


def test_realize_symbols_unknown_kind_defaults_normal_with_warning():
    defs, _, errors, warnings = _realize_symbols(
        {"symbols": [{"slot": "x", "name": "X", "kind": "sparkly"}]})
    assert errors == []
    assert defs == [{"id": 0, "role": "normal"}]
    assert any("sparkly" in w for w in warnings)


def test_realize_symbols_empty_is_hard_error():
    defs, _, errors, _ = _realize_symbols({"symbols": []})
    assert defs == []
    assert any("no symbols" in e.lower() for e in errors)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_realize.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.simulator.realize'`.

- [ ] **Step 3: Create `realize.py`**

```python
"""Pure GDD→SlotModel realizer (SP2). Structural sibling of targets.py.

Compiles the structured GDD math aspects into a structurally-valid (numerically
rough) SlotModel dict the Rust kernel accepts. Pure: no IO, no RNG. Fail-loud:
returns a RealizeResult whose model is None iff a hard structural contradiction
was found. The tuner (SP3) reconciles the numbers; this only fixes structure.
"""
from dataclasses import dataclass
from itertools import product

MAX_PAYLINES = 4096
DEFAULT_STRIP_LEN = 30
DEFAULT_REELS = 5
DEFAULT_ROWS = 3
BONUS_MIN_COUNT = 3

# GDD design-language `kind` -> kernel SymbolRole (serialized lowercase).
_KIND_TO_ROLE = {
    "wild": "wild",
    "scatter": "scatter",
    "bonus": "scatter",  # bonus symbols trigger features via scatter-count
    "high": "normal",
    "low": "normal",
}


def _to_int(raw, default: int) -> int:
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return default
    try:
        return int(float(str(raw)))
    except (ValueError, TypeError):
        return default


def _to_bool(raw) -> bool:
    return str(raw).strip().lower() in ("yes", "true", "1", "y", "on")


@dataclass(frozen=True)
class RealizeResult:
    model: dict | None
    errors: list[str]
    warnings: list[str]


def _realize_symbols(
    symbols_reels: dict,
) -> tuple[list[dict], dict[str, int], list[str], list[str]]:
    """Build SymbolDef rows + a {slot/name -> id} map. id == row index."""
    rows = symbols_reels.get("symbols") or []
    errors: list[str] = []
    warnings: list[str] = []
    defs: list[dict] = []
    name_to_id: dict[str, int] = {}
    for i, row in enumerate(rows):
        kind = str(row.get("kind", "")).strip().lower()
        role = _KIND_TO_ROLE.get(kind)
        if role is None:
            role = "normal"
            warnings.append(
                f"symbol row {i} kind '{row.get('kind')}' unknown; role defaulted to normal"
            )
        defs.append({"id": i, "role": role})
        for key in ("slot", "name"):
            v = str(row.get(key, "")).strip().lower()
            if v:
                name_to_id[v] = i
    if not defs:
        errors.append("no symbols defined; cannot realize a model")
    return defs, name_to_id, errors, warnings
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_realize.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/simulator/realize.py studio/backend/tests/test_realize.py
git commit -m "feat(realize): module skeleton + symbol realization (kind->role, id map)"
```

---

### Task 2: Reel / strip-length realization

**Files:**

- Modify: `studio/backend/app/simulator/realize.py`
- Test: `studio/backend/tests/test_realize.py`

**Interfaces:**

- Consumes: `DEFAULT_STRIP_LEN`, the `distinct_count` (= `len(symbol_defs)`).
- Produces: `_realize_reels(symbols_reels: dict, distinct_count: int, reel_count: int) -> tuple[list[list[int]], list[str], list[str]]`. Seeds length `L = round(mid(strip_length))`, same for every reel; round-robin composition `pos % distinct_count`. Hard error if `strip_length.max < distinct_count`. Soft clamp/default + warning otherwise.

- [ ] **Step 1: Write the failing tests**

Add to `studio/backend/tests/test_realize.py` (extend the import from `app.simulator.realize` to include `_realize_reels`):

```python
def test_realize_reels_seeds_midpoint_length_same_per_reel():
    reels, errors, warnings = _realize_reels(
        {"strip_length": {"min": 30, "max": 40}}, distinct_count=4, reel_count=5)
    assert errors == []
    assert len(reels) == 5
    assert all(len(r) == 35 for r in reels)  # round(mid(30,40)) = 35
    # round-robin pos % 4 over 35 positions
    assert reels[0][:5] == [0, 1, 2, 3, 0]
    from collections import Counter
    assert Counter(reels[0]) == {0: 9, 1: 9, 2: 9, 3: 8}
    assert reels[0] == reels[4]  # identical per reel in SP2


def test_realize_reels_absent_strip_length_defaults_with_warning():
    reels, errors, warnings = _realize_reels({}, distinct_count=4, reel_count=3)
    assert errors == []
    assert all(len(r) == 30 for r in reels)  # max(4, DEFAULT_STRIP_LEN=30)
    assert any("strip_length absent" in w for w in warnings)


def test_realize_reels_midpoint_below_distinct_clamps_up_with_warning():
    reels, errors, warnings = _realize_reels(
        {"strip_length": {"min": 2, "max": 8}}, distinct_count=6, reel_count=2)
    assert errors == []
    assert all(len(r) == 6 for r in reels)  # midpoint 5 -> clamped up to 6
    assert any("clamped" in w for w in warnings)


def test_realize_reels_max_below_distinct_is_hard_error():
    reels, errors, warnings = _realize_reels(
        {"strip_length": {"min": 2, "max": 3}}, distinct_count=6, reel_count=2)
    assert reels == []
    assert any("distinct symbol count" in e for e in errors)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_realize.py -k reels -v`
Expected: FAIL — `ImportError`/`AttributeError`: `_realize_reels` not defined.

- [ ] **Step 3: Add `_realize_reels` to `realize.py`** (after `_realize_symbols`)

```python
def _realize_reels(
    symbols_reels: dict, distinct_count: int, reel_count: int
) -> tuple[list[list[int]], list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    sl = symbols_reels.get("strip_length")
    if isinstance(sl, dict) and "min" in sl and "max" in sl:
        lo, hi = float(sl["min"]), float(sl["max"])
        if hi < distinct_count:
            errors.append(
                f"strip_length.max {hi:g} < distinct symbol count {distinct_count}; "
                "cannot place every symbol on a strip"
            )
            return [], errors, warnings
        length = round((lo + hi) / 2)
        if length < distinct_count:
            warnings.append(
                f"strip_length midpoint {length} < distinct symbol count "
                f"{distinct_count}; clamped up to {distinct_count}"
            )
            length = distinct_count
    else:
        length = max(distinct_count, DEFAULT_STRIP_LEN)
        warnings.append(f"strip_length absent; defaulted strip length to {length}")
    reel = [pos % distinct_count for pos in range(length)]
    return [list(reel) for _ in range(reel_count)], errors, warnings
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_realize.py -v`
Expected: PASS (all, including Task 1's).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/simulator/realize.py studio/backend/tests/test_realize.py
git commit -m "feat(realize): reel/strip-length seeding with clamp+default+hard-error"
```

---

### Task 3: Payline realization — unified generator, modes, overrides, caps

**Files:**

- Modify: `studio/backend/app/simulator/realize.py`
- Test: `studio/backend/tests/test_realize.py`

**Interfaces:**

- Consumes: `MAX_PAYLINES`, `_to_int`.
- Produces:
  - `_all_patterns(rows: int, reel_count: int) -> list[list[int]]` — every `rows ** reel_count` row-combination, straight horizontals first, then lexicographic.
  - `_realize_paylines(math_model: dict, reel_count: int, rows: int) -> tuple[list[list[int]], list[str], list[str]]` — `payline_overrides` (parsed, validated) bypass the generator; `payline_mode="ways"` takes all (capped); `"lines"`/default takes the first `payline_count`.

- [ ] **Step 1: Write the failing tests**

Add to `studio/backend/tests/test_realize.py` (extend the import to include `_all_patterns, _realize_paylines`):

```python
def test_all_patterns_horizontals_first_then_lexicographic():
    pats = _all_patterns(rows=3, reel_count=5)
    assert len(pats) == 243  # 3 ** 5
    assert pats[0] == [0, 0, 0, 0, 0]
    assert pats[1] == [1, 1, 1, 1, 1]
    assert pats[2] == [2, 2, 2, 2, 2]
    assert pats[3] == [0, 0, 0, 0, 1]  # first non-constant, lexicographic
    assert pats[4] == [0, 0, 0, 0, 2]


def test_paylines_lines_mode_takes_first_n():
    lines, errors, warnings = _realize_paylines(
        {"payline_mode": "lines", "payline_count": 5}, reel_count=5, rows=3)
    assert errors == []
    assert lines == [[0, 0, 0, 0, 0], [1, 1, 1, 1, 1], [2, 2, 2, 2, 2],
                     [0, 0, 0, 0, 1], [0, 0, 0, 0, 2]]


def test_paylines_ways_mode_takes_all():
    lines, errors, warnings = _realize_paylines(
        {"payline_mode": "ways", "payline_count": 243}, reel_count=5, rows=3)
    assert errors == []
    assert len(lines) == 243


def test_paylines_overrides_bypass_generator():
    lines, errors, warnings = _realize_paylines(
        {"payline_overrides": ["0,1,2,1,0", "2,2,2,2,2"]}, reel_count=5, rows=3)
    assert errors == []
    assert lines == [[0, 1, 2, 1, 0], [2, 2, 2, 2, 2]]


def test_paylines_override_wrong_length_is_hard_error():
    lines, errors, warnings = _realize_paylines(
        {"payline_overrides": ["0,1,2,1"]}, reel_count=5, rows=3)
    assert lines == []
    assert any("positions but reel count" in e for e in errors)


def test_paylines_override_row_out_of_range_is_hard_error():
    lines, errors, warnings = _realize_paylines(
        {"payline_overrides": ["0,1,2,1,9"]}, reel_count=5, rows=3)
    assert lines == []
    assert any("outside" in e for e in errors)


def test_paylines_lines_count_exceeds_possible_is_hard_error():
    lines, errors, warnings = _realize_paylines(
        {"payline_mode": "lines", "payline_count": 999}, reel_count=2, rows=3)
    assert lines == []  # only 9 possible
    assert any("exceeds" in e for e in errors)


def test_paylines_ways_over_cap_is_hard_error():
    lines, errors, warnings = _realize_paylines(
        {"payline_mode": "ways"}, reel_count=8, rows=4)  # 4**8 = 65536 > 4096
    assert lines == []
    assert any("MAX_PAYLINES" in e for e in errors)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_realize.py -k payline -v`
Expected: FAIL — `_all_patterns`/`_realize_paylines` not defined.

- [ ] **Step 3: Add the generator and `_realize_paylines` to `realize.py`**

```python
def _all_patterns(rows: int, reel_count: int) -> list[list[int]]:
    """Every row-combination across reels: straight horizontals first, then the
    remainder in lexicographic order. Deterministic."""
    combos = list(product(range(rows), repeat=reel_count))
    constants = [list(c) for c in combos if len(set(c)) == 1]
    others = [list(c) for c in combos if len(set(c)) > 1]
    return constants + others


def _realize_paylines(
    math_model: dict, reel_count: int, rows: int
) -> tuple[list[list[int]], list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    overrides = math_model.get("payline_overrides") or []
    if overrides:
        lines: list[list[int]] = []
        for i, pat in enumerate(overrides):
            parts = [p.strip() for p in str(pat).split(",") if p.strip() != ""]
            try:
                idxs = [int(p) for p in parts]
            except ValueError:
                errors.append(f"payline override {i} '{pat}' is not a comma list of integers")
                continue
            if len(idxs) != reel_count:
                errors.append(
                    f"payline override {i} has {len(idxs)} positions but reel count is {reel_count}"
                )
                continue
            bad = [x for x in idxs if x < 0 or x >= rows]
            if bad:
                errors.append(f"payline override {i} has row index {bad} outside [0,{rows})")
                continue
            lines.append(idxs)
        if errors:
            return [], errors, warnings
        return lines, errors, warnings

    total = rows ** reel_count
    mode = str(math_model.get("payline_mode") or "lines").strip().lower()
    if mode == "ways":
        if total > MAX_PAYLINES:
            errors.append(
                f"ways mode needs {total} paylines ({rows}^{reel_count}) which exceeds "
                f"MAX_PAYLINES {MAX_PAYLINES}; use payline_overrides or fewer rows/reels"
            )
            return [], errors, warnings
        declared = math_model.get("payline_count")
        if declared not in (None, "") and _to_int(declared, total) != total:
            warnings.append(
                f"payline_count {declared} != generated ways count {total}; using {total}"
            )
        return _all_patterns(rows, reel_count), errors, warnings

    n = _to_int(math_model.get("payline_count"), 1)
    if n > total:
        errors.append(
            f"payline_count {n} exceeds the {total} distinct paylines possible "
            f"({rows}^{reel_count})"
        )
        return [], errors, warnings
    return _all_patterns(rows, reel_count)[:n], errors, warnings
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_realize.py -v`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/simulator/realize.py studio/backend/tests/test_realize.py
git commit -m "feat(realize): unified payline generator (ways/lines/overrides + caps)"
```

---

### Task 4: Paytable realization

**Files:**

- Modify: `studio/backend/app/simulator/realize.py`
- Test: `studio/backend/tests/test_realize.py`

**Interfaces:**

- Consumes: the `name_to_id` map and `symbol_defs` from Task 1.
- Produces: `_realize_paytable(paytable: dict, name_to_id: dict[str, int], symbol_defs: list[dict]) -> tuple[dict, list[str], list[str]]` returning a `{"entries": [...]}` Paytable. Resolves each `payouts` row's `symbol` cell via `name_to_id`; emits one entry per OAK column present. Unresolved row → warn + skip. Empty result → placeholder ascending payouts for `normal` symbols + warn.

- [ ] **Step 1: Write the failing tests**

Add to `studio/backend/tests/test_realize.py` (extend the import to include `_realize_paytable`):

```python
_DEFS = [
    {"id": 0, "role": "normal"}, {"id": 1, "role": "normal"},
    {"id": 2, "role": "wild"}, {"id": 3, "role": "scatter"},
]
_NAME_TO_ID = {"dragon": 0, "high1": 0, "ten": 1, "low1": 1,
               "rune": 2, "coin": 3}


def test_paytable_resolves_rows_to_oak_entries():
    pt = {"payouts": [
        {"symbol": "Dragon", "3oak": "5", "4oak": "20", "5oak": "100"},
        {"symbol": "Ten", "3oak": "2", "4oak": "8", "5oak": "40"},
    ]}
    out, errors, warnings = _realize_paytable(pt, _NAME_TO_ID, _DEFS)
    assert errors == []
    assert out == {"entries": [
        {"symbol": 0, "count": 3, "payout": 5},
        {"symbol": 0, "count": 4, "payout": 20},
        {"symbol": 0, "count": 5, "payout": 100},
        {"symbol": 1, "count": 3, "payout": 2},
        {"symbol": 1, "count": 4, "payout": 8},
        {"symbol": 1, "count": 5, "payout": 40},
    ]}


def test_paytable_unresolved_symbol_warns_and_skips():
    pt = {"payouts": [{"symbol": "Ghost", "3oak": "5"}]}
    out, errors, warnings = _realize_paytable(pt, _NAME_TO_ID, _DEFS)
    # nothing resolved -> falls back to placeholder; the skip is warned
    assert any("Ghost" in w for w in warnings)


def test_paytable_empty_seeds_placeholder_for_normal_symbols():
    out, errors, warnings = _realize_paytable({}, _NAME_TO_ID, _DEFS)
    assert errors == []
    # only the two normal symbols (ids 0,1) get placeholder entries
    syms = {e["symbol"] for e in out["entries"]}
    assert syms == {0, 1}
    assert any("placeholder" in w for w in warnings)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_realize.py -k paytable -v`
Expected: FAIL — `_realize_paytable` not defined.

- [ ] **Step 3: Add `_realize_paytable` to `realize.py`**

```python
_OAK_COLUMNS = {"3oak": 3, "4oak": 4, "5oak": 5}


def _realize_paytable(
    paytable: dict, name_to_id: dict[str, int], symbol_defs: list[dict]
) -> tuple[dict, list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    entries: list[dict] = []
    for i, row in enumerate(paytable.get("payouts") or []):
        sym = str(row.get("symbol", "")).strip().lower()
        sid = name_to_id.get(sym)
        if sid is None:
            warnings.append(
                f"paytable row {i} symbol '{row.get('symbol')}' does not resolve "
                "to a known symbol; skipped"
            )
            continue
        for col, count in _OAK_COLUMNS.items():
            raw = row.get(col)
            if raw is None or (isinstance(raw, str) and not raw.strip()):
                continue
            try:
                payout = int(float(str(raw)))
            except ValueError:
                warnings.append(f"paytable row {i} {col} '{raw}' is not numeric; skipped")
                continue
            entries.append({"symbol": sid, "count": count, "payout": payout})
    if not entries:
        for rank, d in enumerate(d for d in symbol_defs if d["role"] == "normal"):
            base = rank + 1
            entries.append({"symbol": d["id"], "count": 3, "payout": base})
            entries.append({"symbol": d["id"], "count": 4, "payout": base * 5})
            entries.append({"symbol": d["id"], "count": 5, "payout": base * 20})
        warnings.append(
            "paytable empty or unresolved; seeded placeholder payouts for paying symbols"
        )
    return {"entries": entries}, errors, warnings
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_realize.py -v`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/simulator/realize.py studio/backend/tests/test_realize.py
git commit -m "feat(realize): paytable resolution with placeholder seeding"
```

---

### Task 5: Bonus realization

**Files:**

- Modify: `studio/backend/app/simulator/realize.py`
- Test: `studio/backend/tests/test_realize.py`

**Interfaces:**

- Consumes: `symbol_defs`, `BONUS_MIN_COUNT`, `_to_int`, `_to_bool`.
- Produces: `_realize_bonuses(bonus_features: dict, symbol_defs: list[dict]) -> tuple[list[dict], list[str], list[str]]` — maps each `free_spins` row to an externally-tagged `{"FreeSpins": {...}}`. Trigger symbol = first `scatter`-role symbol. No trigger symbol → warn + skip (returns `[]`).

- [ ] **Step 1: Write the failing tests**

Add to `studio/backend/tests/test_realize.py` (extend the import to include `_realize_bonuses`):

```python
def test_bonuses_map_free_spins_to_external_tagged_freespins():
    bf = {"free_spins": [
        {"trigger": "3 scatters", "count": "10", "retrigger": "yes", "multiplier": "2"}]}
    out, errors, warnings = _realize_bonuses(bf, _DEFS)
    assert errors == []
    assert out == [{"FreeSpins": {
        "trigger": {"symbol": 3, "min_count": 3},
        "config": {"spins_awarded": 10, "retrigger": True,
                   "multiplier": 2, "feature_reels": None},
    }}]


def test_bonuses_without_trigger_symbol_warns_and_skips():
    defs_no_scatter = [{"id": 0, "role": "normal"}, {"id": 1, "role": "wild"}]
    out, errors, warnings = _realize_bonuses(
        {"free_spins": [{"count": "5"}]}, defs_no_scatter)
    assert out == []
    assert any("trigger symbol" in w for w in warnings)


def test_bonuses_absent_is_empty_no_warning():
    out, errors, warnings = _realize_bonuses({}, _DEFS)
    assert out == [] and errors == [] and warnings == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_realize.py -k bonus -v`
Expected: FAIL — `_realize_bonuses` not defined.

- [ ] **Step 3: Add `_realize_bonuses` to `realize.py`**

```python
def _realize_bonuses(
    bonus_features: dict, symbol_defs: list[dict]
) -> tuple[list[dict], list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    rows = bonus_features.get("free_spins") or []
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
    for row in rows:
        bonuses.append({"FreeSpins": {
            "trigger": {"symbol": trigger, "min_count": BONUS_MIN_COUNT},
            "config": {
                "spins_awarded": _to_int(row.get("count"), 0),
                "retrigger": _to_bool(row.get("retrigger")),
                "multiplier": _to_int(row.get("multiplier"), 1),
                "feature_reels": None,
            },
        }})
    return bonuses, errors, warnings
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_realize.py -v`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/simulator/realize.py studio/backend/tests/test_realize.py
git commit -m "feat(realize): bonus realization (free_spins -> external-tagged FreeSpins)"
```

---

### Task 6: Top-level assembly + full golden vector + diagnostic aggregation

**Files:**

- Modify: `studio/backend/app/simulator/realize.py`
- Test: `studio/backend/tests/test_realize.py`

**Interfaces:**

- Consumes: every `_realize_*` helper, `DEFAULT_REELS`, `DEFAULT_ROWS`, `_to_int`.
- Produces: `realize_slot_model(math_model: dict, symbols_reels: dict, paytable: dict, bonus_features: dict) -> RealizeResult`. Threads symbols→id-map through the helpers, applies `reels`/`rows` defaults (with warnings), aggregates all diagnostics, and returns `model=None` if any error surfaced.

- [ ] **Step 1: Write the failing tests**

Add to `studio/backend/tests/test_realize.py` (extend the import to include `realize_slot_model`). Define a module-level canonical GDD and assert the full model:

```python
_GDD_MATH = {"rtp": "0.96", "volatility": "high", "reels": 5, "rows": 3,
             "payline_mode": "lines", "payline_count": 5, "bonus_hit_rate": "1:150"}
_GDD_SYMBOLS = {"symbols": [
    {"slot": "high1", "name": "Dragon", "kind": "high", "art_desc": "a dragon"},
    {"slot": "low1", "name": "Ten", "kind": "low", "art_desc": "a ten"},
    {"slot": "wild", "name": "Rune", "kind": "wild", "art_desc": "a rune"},
    {"slot": "scatter", "name": "Coin", "kind": "scatter", "art_desc": "a coin"},
], "strip_length": {"min": 30, "max": 40}}
_GDD_PAYTABLE = {"payouts": [
    {"symbol": "Dragon", "3oak": "5", "4oak": "20", "5oak": "100"},
    {"symbol": "Ten", "3oak": "2", "4oak": "8", "5oak": "40"},
]}
_GDD_BONUS = {"free_spins": [
    {"trigger": "3 scatters", "count": "10", "retrigger": "yes", "multiplier": "2"}]}


def test_realize_golden_vector():
    res = realize_slot_model(_GDD_MATH, _GDD_SYMBOLS, _GDD_PAYTABLE, _GDD_BONUS)
    assert res.errors == []
    m = res.model
    assert m["symbols"] == [
        {"id": 0, "role": "normal"}, {"id": 1, "role": "normal"},
        {"id": 2, "role": "wild"}, {"id": 3, "role": "scatter"}]
    assert m["rows"] == 3
    assert len(m["reels"]) == 5 and all(len(r) == 35 for r in m["reels"])
    assert m["paylines"] == [[0, 0, 0, 0, 0], [1, 1, 1, 1, 1], [2, 2, 2, 2, 2],
                             [0, 0, 0, 0, 1], [0, 0, 0, 0, 2]]
    assert m["paytable"]["entries"][0] == {"symbol": 0, "count": 3, "payout": 5}
    assert m["bonuses"] == [{"FreeSpins": {
        "trigger": {"symbol": 3, "min_count": 3},
        "config": {"spins_awarded": 10, "retrigger": True,
                   "multiplier": 2, "feature_reels": None}}}]


def test_realize_returns_none_on_hard_error():
    res = realize_slot_model(_GDD_MATH, {"symbols": []}, _GDD_PAYTABLE, _GDD_BONUS)
    assert res.model is None
    assert any("no symbols" in e.lower() for e in res.errors)


def test_realize_defaults_reels_and_rows_with_warnings():
    res = realize_slot_model(
        {"payline_mode": "lines", "payline_count": 1}, _GDD_SYMBOLS, _GDD_PAYTABLE, _GDD_BONUS)
    assert res.model is not None
    assert len(res.model["reels"]) == 5  # DEFAULT_REELS
    assert res.model["rows"] == 3        # DEFAULT_ROWS
    assert any("reels absent" in w for w in res.warnings)
    assert any("rows absent" in w for w in res.warnings)


def test_realize_aggregates_all_diagnostics_before_failing():
    # symbols OK, but BOTH a bad override AND strip_length.max < distinct count.
    # Both helpers run and both errors surface before the single None return.
    sr = {"symbols": _GDD_SYMBOLS["symbols"], "strip_length": {"min": 1, "max": 2}}
    res = realize_slot_model(
        {"payline_overrides": ["0,1"]}, sr, _GDD_PAYTABLE, _GDD_BONUS)
    assert res.model is None
    assert any("reel count" in e for e in res.errors)             # override length
    assert any("distinct symbol count" in e for e in res.errors)  # strip_length.max
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_realize.py -k "golden or realize_returns or defaults or aggregates" -v`
Expected: FAIL — `realize_slot_model` not defined.

- [ ] **Step 3: Add `realize_slot_model` to `realize.py`** (at the end)

```python
def realize_slot_model(
    math_model: dict,
    symbols_reels: dict,
    paytable: dict,
    bonus_features: dict,
) -> RealizeResult:
    """Compile the structured GDD math aspects into a SlotModel dict. Fail-loud:
    model is None iff a hard structural contradiction was found."""
    errors: list[str] = []
    warnings: list[str] = []

    symbol_defs, name_to_id, e, w = _realize_symbols(symbols_reels)
    errors += e
    warnings += w
    if not symbol_defs:
        return RealizeResult(None, errors, warnings)
    distinct = len(symbol_defs)

    if math_model.get("reels") in (None, ""):
        warnings.append(f"reels absent; defaulted to {DEFAULT_REELS}")
    reel_count = _to_int(math_model.get("reels"), DEFAULT_REELS)
    if math_model.get("rows") in (None, ""):
        warnings.append(f"rows absent; defaulted to {DEFAULT_ROWS}")
    rows = _to_int(math_model.get("rows"), DEFAULT_ROWS)

    reels, e, w = _realize_reels(symbols_reels, distinct, reel_count)
    errors += e
    warnings += w
    paylines, e, w = _realize_paylines(math_model, reel_count, rows)
    errors += e
    warnings += w
    paytable_out, e, w = _realize_paytable(paytable, name_to_id, symbol_defs)
    errors += e
    warnings += w
    bonuses, e, w = _realize_bonuses(bonus_features, symbol_defs)
    errors += e
    warnings += w

    if errors:
        return RealizeResult(None, errors, warnings)

    model = {
        "symbols": symbol_defs,
        "reels": reels,
        "rows": rows,
        "paylines": paylines,
        "paytable": paytable_out,
        "bonuses": bonuses,
    }
    return RealizeResult(model, errors, warnings)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_realize.py -v`
Expected: PASS (all unit tests).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/simulator/realize.py studio/backend/tests/test_realize.py
git commit -m "feat(realize): top-level realize_slot_model assembly + golden vector"
```

---

### Task 7: Parity-oracle e2e — realized model runs through the real simulator binary

**Files:**

- Create: `studio/backend/tests/e2e/test_realize_parity.py`

**Interfaces:**

- Consumes: `realize_slot_model` (Task 6); the existing `SubprocessCurationRunner` (`app/simulator/runner.py`) and `get_settings` (`app/config.py`).
- Produces: an offline (cargo-backed, no MongoDB) e2e proving the realized model is structurally valid — the kernel deserializes it and reaches the `simulate` phase.

**Note (important):** A freshly-realized model is _numerically rough_; it will almost never pass RTP curation. So this test asserts **structural** success — the run returns a result and a `simulate` progress phase was observed — **not** `status == "pass"`. The model's numbers are the tuner's job (SP3).

- [ ] **Step 1: Write the test**

Create `studio/backend/tests/e2e/test_realize_parity.py`:

```python
"""Parity oracle: a realized SlotModel is fed to the REAL simulator binary and
must deserialize + evaluate. Proves the realizer emits the kernel's exact serde
shape without re-hosting the realizer in Rust. Marked e2e (needs the cargo
toolchain); offline + deterministic, no MongoDB, no cassettes.

A freshly-realized model is numerically rough, so we assert STRUCTURAL success
(the binary deserialized it and reached the simulate phase), not curation pass.
"""
import math

import pytest

from app.config import get_settings
from app.simulator.realize import realize_slot_model
from app.simulator.runner import CurationProgress, SubprocessCurationRunner

_MATH = {"reels": 5, "rows": 3, "payline_mode": "lines", "payline_count": 5}
_SYMBOLS = {"symbols": [
    {"slot": "high1", "name": "Dragon", "kind": "high"},
    {"slot": "low1", "name": "Ten", "kind": "low"},
    {"slot": "wild", "name": "Rune", "kind": "wild"},
    {"slot": "scatter", "name": "Coin", "kind": "scatter"},
], "strip_length": {"min": 30, "max": 40}}
_PAYTABLE = {"payouts": [
    {"symbol": "Dragon", "3oak": "5", "4oak": "20", "5oak": "100"},
    {"symbol": "Ten", "3oak": "2", "4oak": "8", "5oak": "40"},
]}
_BONUS = {"free_spins": [
    {"trigger": "3 scatters", "count": "10", "retrigger": "yes", "multiplier": "2"}]}

# A permissive target: we only need curation to RUN to completion, not to pass.
_TARGET = {
    "rtp_target": 0.9, "rtp_tolerance": 0.5, "volatility_min": 0.0,
    "volatility_max": 1e9, "bonus_hit_rate_bands": [{"min": 0.0, "max": 1.0}],
    "pool_size": 200, "candidate_count": 2000,
    "realized_correction_band": 0.5, "master_seed": 2026,
}


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_realized_model_is_structurally_valid_for_the_kernel():
    res = realize_slot_model(_MATH, _SYMBOLS, _PAYTABLE, _BONUS)
    assert res.model is not None, f"realize failed: {res.errors}"

    seen: list[CurationProgress] = []
    runner = SubprocessCurationRunner(get_settings())
    result = await runner.run(res.model, _TARGET, on_progress=seen.append)

    # Structural-validity oracle: the binary deserialized our model and evaluated
    # it (reached the simulate phase) and returned a finite RTP. We do NOT assert
    # curation passed — a rough model's numbers are the tuner's job (SP3).
    assert any(p.phase == "simulate" for p in seen), "binary never reached simulate"
    assert result is not None
    assert math.isfinite(result.metrics.rtp)
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `uv --directory studio/backend run pytest tests/e2e/test_realize_parity.py -v -m e2e`
Expected: PASS — the realized model deserializes in the Rust binary, a `simulate` phase is observed, and `result.metrics.rtp` is finite. (Requires `cargo` on PATH; the runner falls back to `cargo run --release -p bloom-simulator --bin curate_json` when `SIMULATOR_BIN` is unset.)

If it fails at deserialize (the binary rejects the model), the realizer is emitting a wrong serde shape — fix `realize.py` to match the Global Constraints serde spelling; do **not** weaken this test.

- [ ] **Step 3: Commit**

```bash
git add studio/backend/tests/e2e/test_realize_parity.py
git commit -m "test(realize): parity-oracle e2e — realized model runs in the real kernel"
```

---

### Task 8: Whole-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full unit suite**

Run: `uv --directory studio/backend run pytest -q`
Expected: PASS — all existing tests plus the new `test_realize.py`. (The parity e2e is excluded from the default run unless `-m e2e` is passed; confirm the unit run is green.)

- [ ] **Step 2: Run the parity e2e explicitly**

Run: `uv --directory studio/backend run pytest tests/e2e/test_realize_parity.py -v -m e2e`
Expected: PASS (cargo toolchain required).

- [ ] **Step 3: Confirm the branch is clean**

Run: `git status -sb`
Expected: no uncommitted changes; branch `feat/gdd-realizer` ahead of `main`.

---

## Self-Review (completed)

- **Spec coverage:** §3 serde shape → Global Constraints + Task 6 golden + Task 7 parity; §4 contract (`RealizeResult`, fail-loud) → Task 1 + Task 6; §4.1 diagnostics → every hard/soft case has a test (Tasks 2,3,4,5,6); §5.1 symbols → Task 1; §5.2 reels/strip → Task 2; §5.3 paylines → Task 3; §5.4 paytable → Task 4; §5.5 bonuses → Task 5; §5.6 constants → Task 1; §7 tests (golden + diagnostics + parity) → Tasks 6,7. Every section maps to a task.
- **Placeholder scan:** no TBD/TODO; every code step shows complete code; commands carry expected output.
- **Type consistency:** helper signatures in each task's Interfaces block match their call sites in Task 6's `realize_slot_model`; the serde dict shapes in Tasks 1–5 match the Global Constraints and the Task 6 golden assertions and the Task 7 parity input.
- **Determinism:** no RNG anywhere; round-robin reels and `itertools.product` payline ordering are stable, so the golden vector is reproducible.

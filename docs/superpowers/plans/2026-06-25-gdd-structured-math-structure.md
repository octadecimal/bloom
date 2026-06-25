# Structured math-structure GDD schema (SP1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the slot math's structural identity addressable as typed GDD fields, so structural design intent (e.g. "longer reel strips") lands in a real field instead of silently no-opping.

**Architecture:** Extend the existing GDD aspects (`math-model`, `symbols-reels`) with structured payline topology, an enum-validated symbol `kind` column, and a new `strip_length` range. Two small schema-system primitives are added: a `range` field type and per-column enum validation. All changes are in the Python backend GDD layer (`studio/backend/app/gdd/`); no realizer and no Rust — those are SP2/SP3.

**Tech Stack:** Python 3.12, pytest, `uv` for the backend; the GDD typed-schema system (`schemas.py` / `normalize.py` / `render.py`), the design-router (`router.py`), and the replay e2e harness (prompt-keyed run cassettes).

## Global Constraints

- **Normalizers coerce and warn, never raise.** Every `normalize_value` path returns `(value, warning_or_None)`; bad input returns the raw value plus an advisory string.
- **All new fields are optional** (no `required=True`) so existing GDD docs do not flip to `needs_input` and `derive_status` is unaffected.
- **No realizer, no Rust, no frontend code.** SP1 is schema + normalization + render + chat-surface only. The frontend viewer consumes the rendered `body` markdown unchanged.
- **The `kind` column enum is advisory.** SP1 warns on out-of-enum values; it does not transform or reject them. The realizer (SP2) maps `kind` → kernel `SymbolRole`.
- **Removed fields take no data migration.** `paylines` (text) and `reel_strips` (table) leave the schema; orphaned values in Mongo `data` are never read again.
- **Run commands from the worktree root** (`C:\code\bloom.wt\gdd-math-structure`). Backend tests run via `uv --directory studio/backend run pytest`.
- **Prettier gate:** the Frontend CI job runs `prettier --check .` repo-wide and catches `docs/**/*.md` and skill `.md` files. Run `npx prettier --write` on any touched markdown before committing.

---

## File Structure

- `studio/backend/app/gdd/schemas.py` — **modify.** Add `"range"` to `FieldType`; add `enum` to `Column`; let `_t` accept 3-tuples; rewrite the `math-model` payline fields and the `symbols-reels` aspect; extend `field_catalog()` to emit column enums.
- `studio/backend/app/gdd/normalize.py` — **modify.** Add `_range`; wire it into `normalize_value`; add enum-column validation to `_table`.
- `studio/backend/app/gdd/render.py` — **modify.** Format `range` in `_fmt`.
- `studio/backend/app/gdd/router.py` — **modify.** Render column enums in `_render_catalog`.
- `skills/design-game.md` — **modify.** Instruct the agent to fill the new structural fields.
- `studio/backend/tests/test_gdd_schemas.py` — **modify.** Cover the new fields, the range type, and column enums in the catalog.
- `studio/backend/tests/test_gdd_normalize.py` — **modify.** Cover `_range` and table enum validation.
- `studio/backend/tests/test_gdd_render.py` — **modify.** Cover range rendering.
- `studio/backend/tests/test_gdd_router.py` — **modify.** Assert the rendered catalog shows the new enums.
- `studio/backend/tests/e2e/test_gdd_structure_routing.py` — **create.** Backend service e2e: plain chat sets `strip_length`.
- `studio/backend/tests/fixtures/replay/run/route-strip-length.json` — **create.** Prompt-keyed cassette for the e2e.

---

### Task 1: Schema — `range` type, column enums, and the structural field set

**Files:**

- Modify: `studio/backend/app/gdd/schemas.py`
- Test: `studio/backend/tests/test_gdd_schemas.py`

**Interfaces:**

- Consumes: nothing (first task).
- Produces:
  - `FieldType` now includes `"range"`.
  - `Column(key: str, label: str, enum: tuple[str, ...] | None = None)`.
  - `math-model` fields: `payline_mode` (enum `("lines","ways")`), `payline_count` (number), `payline_overrides` (list); the old `paylines` (text) field is gone.
  - `symbols-reels` fields: `symbols` table whose `kind` column carries `enum=("high","low","wild","scatter","bonus")`; new `strip_length` (range); the old `reel_strips` table is gone.
  - `field_catalog()` rows gain a `"columns"` key: `None`, or a list of `{key, label, enum}` for table fields.

- [ ] **Step 1: Write the failing tests**

Add to `studio/backend/tests/test_gdd_schemas.py`:

```python
def test_math_model_payline_topology_is_structured():
    fields = {f.key: f for f in schema_for("math-model")}
    assert "paylines" not in fields  # old free-text field removed
    assert fields["payline_mode"].type == "enum"
    assert fields["payline_mode"].enum == ("lines", "ways")
    assert fields["payline_count"].type == "number"
    assert fields["payline_overrides"].type == "list"
    # all new fields are optional
    assert not fields["payline_mode"].required
    assert not fields["payline_count"].required
    assert not fields["payline_overrides"].required


def test_symbols_reels_has_strip_length_range_and_no_composition():
    fields = {f.key: f for f in schema_for("symbols-reels")}
    assert "reel_strips" not in fields  # free-text composition table removed
    assert fields["strip_length"].type == "range"
    assert not fields["strip_length"].required


def test_symbols_kind_column_is_enum_constrained():
    symbols = next(f for f in schema_for("symbols-reels") if f.key == "symbols")
    kind = next(c for c in symbols.columns if c.key == "kind")
    assert kind.enum == ("high", "low", "wild", "scatter", "bonus")


def test_field_catalog_emits_column_enums():
    from app.gdd.schemas import field_catalog
    cat = field_catalog()
    symbols = next(f for f in cat["symbols-reels"] if f["key"] == "symbols")
    kind = next(c for c in symbols["columns"] if c["key"] == "kind")
    assert kind["enum"] == ["high", "low", "wild", "scatter", "bonus"]
    # non-table fields carry columns=None
    rtp = next(f for f in cat["math-model"] if f["key"] == "rtp")
    assert rtp["columns"] is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_gdd_schemas.py -v`
Expected: the four new tests FAIL (e.g. `KeyError: 'payline_mode'`, `AttributeError`/`KeyError` on `columns`).

- [ ] **Step 3: Edit `schemas.py`**

Change the `FieldType` alias (line 4) to add `"range"`:

```python
FieldType = Literal["number", "percent", "ratio", "enum", "text", "table", "list", "range"]
```

Add `enum` to `Column` (lines 8-12):

```python
@dataclass(frozen=True)
class Column:
    key: str
    label: str
    enum: tuple[str, ...] | None = None
```

Replace the `_t` helper (lines 27-28) so it accepts 2- or 3-tuples (the 3rd element is the column enum):

```python
def _t(*pairs: tuple) -> tuple[Column, ...]:
    return tuple(
        Column(p[0], p[1], p[2]) if len(p) == 3 else Column(p[0], p[1])
        for p in pairs
    )
```

Replace the `math-model` aspect (lines 41-52) — swap the single `paylines` field for the three structured payline fields:

```python
    "math-model": [
        Field("rtp", "RTP", "percent", "param", required=True),
        Field("volatility", "Volatility", "enum", "param", required=True,
              enum=("low", "medium", "medium-high", "high")),
        Field("reels", "Reels", "number", "param", default=5),
        Field("rows", "Rows", "number", "param", default=3),
        Field("payline_mode", "Payline mode", "enum", "param",
              enum=("lines", "ways")),
        Field("payline_count", "Payline count", "number", "param"),
        Field("payline_overrides", "Payline overrides", "list", "param"),
        Field("max_win", "Max win (x bet)", "number", "param"),
        Field("hit_frequency", "Hit frequency", "percent", "param"),
        Field("bonus_hit_rate", "Bonus hit rate", "ratio", "param", required=True),
        Field("bet_range", "Bet range", "text", "param"),
    ],
```

Replace the `symbols-reels` aspect (lines 53-61) — enum on the `kind` column, drop `reel_strips`, add `strip_length`:

```python
    "symbols-reels": [
        Field("symbols", "Symbols", "table", "param", required=True,
              columns=_t(("slot", "Slot"), ("name", "Name"),
                         ("kind", "Kind",
                          ("high", "low", "wild", "scatter", "bonus")),
                         ("art_desc", "Art description"))),
        Field("strip_length", "Strip length", "range", "param"),
        Field("wild_behavior", "Wild behavior", "text", "narrative"),
        Field("scatter_behavior", "Scatter behavior", "text", "narrative"),
    ],
```

Extend `field_catalog()` (lines 102-121) so each row carries a `columns` entry:

```python
def field_catalog() -> dict[str, list[dict]]:
    """Machine-readable catalog of every aspect's fields for the design router.

    Maps aspect -> ordered list of {key, label, type, role, required, enum,
    columns}. Seeds the design-router prompt with the addressable design surface.
    """
    return {
        aspect: [
            {
                "key": f.key,
                "label": f.label,
                "type": f.type,
                "role": f.role,
                "required": f.required,
                "enum": list(f.enum) if f.enum else None,
                "columns": [
                    {
                        "key": c.key,
                        "label": c.label,
                        "enum": list(c.enum) if c.enum else None,
                    }
                    for c in f.columns
                ] if f.columns else None,
            }
            for f in fields
        ]
        for aspect, fields in ASPECT_SCHEMAS.items()
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_gdd_schemas.py -v`
Expected: PASS (all schema tests, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/gdd/schemas.py studio/backend/tests/test_gdd_schemas.py
git commit -m "feat(gdd): structured payline + strip-length schema, range type, column enums"
```

---

### Task 2: Normalization — `_range` and table enum validation

**Files:**

- Modify: `studio/backend/app/gdd/normalize.py`
- Test: `studio/backend/tests/test_gdd_normalize.py`

**Interfaces:**

- Consumes: `Field`/`Column` (with `enum`) and the `"range"` type from Task 1.
- Produces:
  - `normalize_value(field, raw)` handles `field.type == "range"` → `({"min": float, "max": float}, warn)`.
  - A range string like `"8-20"` / `"8 to 20"` and a `{"min","max"}` dict both normalize; reversed bounds swap and warn.
  - `_table` emits an advisory warning when an enum-constrained column cell is out of its enum (cell value is preserved, not transformed).

- [ ] **Step 1: Write the failing tests**

Add to `studio/backend/tests/test_gdd_normalize.py` (extend the imports/fixtures at the top):

```python
RANGE = Field("strip_length", "Strip length", "range", "param")
KIND_TABLE = Field(
    "symbols", "Symbols", "table", "param",
    columns=(Column("slot", "Slot"),
             Column("kind", "Kind", ("high", "low", "wild", "scatter", "bonus"))),
)


def test_range_parses_dict_and_strings():
    assert normalize_value(RANGE, {"min": 8, "max": 20}) == ({"min": 8.0, "max": 20.0}, None)
    assert normalize_value(RANGE, "8-20") == ({"min": 8.0, "max": 20.0}, None)
    assert normalize_value(RANGE, "8 to 20") == ({"min": 8.0, "max": 20.0}, None)


def test_range_swaps_reversed_bounds_with_warning():
    value, warn = normalize_value(RANGE, {"min": 40, "max": 30})
    assert value == {"min": 30.0, "max": 40.0}
    assert warn is not None


def test_range_bad_input_warns_not_raises():
    value, warn = normalize_value(RANGE, "lots")
    assert value == "lots" and warn is not None


def test_table_enum_column_warns_on_out_of_enum():
    ok, ok_warn = normalize_value(
        KIND_TABLE, [{"slot": "high1", "kind": "high"}])
    assert ok == [{"slot": "high1", "kind": "high"}] and ok_warn is None
    bad, bad_warn = normalize_value(
        KIND_TABLE, [{"slot": "x", "kind": "sparkly"}])
    assert bad == [{"slot": "x", "kind": "sparkly"}]  # value preserved
    assert bad_warn is not None  # advisory warning
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_gdd_normalize.py -v`
Expected: the four new tests FAIL (range returns `(raw, None)` via the `str(raw)` fallback; enum column not validated).

- [ ] **Step 3: Edit `normalize.py`**

Add the `range` branch in `normalize_value` (after the `list` branch, before the final return on line 18-19):

```python
    if field.type == "list":
        return _list(raw)
    if field.type == "range":
        return _range(raw)
    return (str(raw), None)
```

Add the `_range` function (next to the other `_` helpers):

```python
def _range(raw) -> tuple[object, str | None]:
    if isinstance(raw, dict):
        try:
            lo, hi = float(raw["min"]), float(raw["max"])
        except (KeyError, TypeError, ValueError):
            return (raw, f"could not parse '{raw}' as a range (need numeric min/max)")
    else:
        nums = re.findall(r"-?\d+(?:\.\d+)?", str(raw))
        if len(nums) < 2:
            return (raw, f"could not parse '{raw}' as a range (use e.g. '8-20')")
        lo, hi = float(nums[0]), float(nums[1])
    warn = None
    if lo > hi:
        lo, hi = hi, lo
        warn = f"range min > max; swapped to min {lo:g}, max {hi:g}"
    return ({"min": lo, "max": hi}, warn)
```

Replace `_table` (lines 73-87) to validate enum columns:

```python
def _table(field: Field, raw) -> tuple[object, str | None]:
    cols = field.columns or ()
    col_keys = [c.key for c in cols]
    if not isinstance(raw, list):
        return (raw, f"{field.key} expects a list of row objects")
    warns: list[str] = []
    rows: list[dict] = []
    for i, row in enumerate(raw):
        if not isinstance(row, dict):
            warns.append(f"{field.key} row {i} is not an object")
            continue
        rows.append({c: row.get(c, "") for c in col_keys})
        missing = [c for c in col_keys if c not in row]
        if missing:
            warns.append(f"{field.key} row {i} missing {missing}")
        for col in cols:
            if col.enum and col.key in row:
                cell = str(row[col.key]).strip().lower()
                if cell not in col.enum:
                    warns.append(
                        f"{field.key} row {i} {col.key} '{row[col.key]}' "
                        f"not one of {list(col.enum)}"
                    )
    return (rows, "; ".join(warns) if warns else None)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_gdd_normalize.py -v`
Expected: PASS (new and pre-existing normalize tests).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/gdd/normalize.py studio/backend/tests/test_gdd_normalize.py
git commit -m "feat(gdd): normalize range values and validate enum table columns"
```

---

### Task 3: Render — format `range` in the Parameters block

**Files:**

- Modify: `studio/backend/app/gdd/render.py`
- Test: `studio/backend/tests/test_gdd_render.py`

**Interfaces:**

- Consumes: the `strip_length` range field (Task 1) and its normalized `{"min","max"}` value (Task 2).
- Produces: `render()` emits `**Strip length:** 8–20` (en-dash) for a range value in the Parameters block. No new function signatures.

- [ ] **Step 1: Write the failing test**

Add to `studio/backend/tests/test_gdd_render.py`:

```python
def test_range_renders_as_min_dash_max():
    schema = schema_for("symbols-reels")
    out = render(schema, {
        "symbols": [{"slot": "high1", "name": "Dragon", "kind": "high", "art_desc": "a dragon"}],
        "strip_length": {"min": 8, "max": 20},
    })
    assert "**Strip length:** 8–20" in out
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_gdd_render.py::test_range_renders_as_min_dash_max -v`
Expected: FAIL — the range renders via `str(val)` as the raw dict, not `8–20`.

- [ ] **Step 3: Edit `render.py`**

Add a `range` branch to `_fmt` (lines 51-62), before the final `return str(val)`:

```python
def _fmt(field: Field, val) -> str:
    if field.type == "percent":
        try:
            return f"{float(val) * 100:g}%"
        except (ValueError, TypeError):
            return str(val)
    if field.type == "number":
        try:
            return f"{float(val):g}"
        except (ValueError, TypeError):
            return str(val)
    if field.type == "range":
        try:
            return f"{float(val['min']):g}–{float(val['max']):g}"
        except (KeyError, TypeError, ValueError):
            return str(val)
    return str(val)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `uv --directory studio/backend run pytest tests/test_gdd_render.py -v`
Expected: PASS (new and pre-existing render tests).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/gdd/render.py studio/backend/tests/test_gdd_render.py
git commit -m "feat(gdd): render range fields as min–max in the params block"
```

---

### Task 4: Router catalog — surface column enums to the design router

**Files:**

- Modify: `studio/backend/app/gdd/router.py`
- Test: `studio/backend/tests/test_gdd_router.py`

**Interfaces:**

- Consumes: `field_catalog()` rows with the `columns` key (Task 1).
- Produces: `build_design_router_spec().body` lists, under a table field, each enum-constrained column and its allowed values (so the router can pass valid `kind` values). The new `payline_mode` enum already renders via the existing field-enum path.

- [ ] **Step 1: Write the failing test**

Add to `studio/backend/tests/test_gdd_router.py`:

```python
def test_router_catalog_shows_new_structural_enums():
    from app.gdd.router import build_design_router_spec
    body = build_design_router_spec().body
    # the new payline_mode enum renders via the field-enum path
    assert "payline_mode" in body
    assert "lines, ways" in body
    # the strip_length range field is addressable
    assert "strip_length" in body
    # the symbols table's kind column exposes its enum values
    assert "high, low, wild, scatter, bonus" in body
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_gdd_router.py::test_router_catalog_shows_new_structural_enums -v`
Expected: FAIL — the `kind` column enum is not rendered (the catalog rendering ignores columns).

- [ ] **Step 3: Edit `router.py`**

Replace `_render_catalog` (lines 8-17) to render enum-constrained columns under their table field:

```python
def _render_catalog(catalog: dict[str, list[dict]]) -> str:
    lines: list[str] = []
    for aspect, fields in catalog.items():
        lines.append(f"- {aspect}")
        for f in fields:
            extra = ", required" if f["required"] else ""
            if f["enum"]:
                extra += f", one of: {', '.join(str(e) for e in f['enum'])}"
            lines.append(f"    - {f['key']} ({f['type']}{extra}) — {f['label']}")
            for c in (f.get("columns") or []):
                if c["enum"]:
                    lines.append(
                        f"        - column {c['key']} one of: "
                        f"{', '.join(c['enum'])}"
                    )
    return "\n".join(lines)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `uv --directory studio/backend run pytest tests/test_gdd_router.py -v`
Expected: PASS (new and pre-existing router tests).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/gdd/router.py studio/backend/tests/test_gdd_router.py
git commit -m "feat(gdd): expose column enums in the design-router catalog"
```

---

### Task 5: Skill — teach design-game to fill the structural fields

**Files:**

- Modify: `skills/design-game.md`
- Test: full backend suite (skill-registry load) + prettier.

**Interfaces:**

- Consumes: the new fields are reachable via the unchanged `set_gdd_fields` tool; `design-game`'s bound tools are unchanged.
- Produces: prose guidance only — no code, no tool-surface change.

- [ ] **Step 1: Edit `skills/design-game.md`**

In the DRAFT-ALL section, replace the **Symbol slot ids** note (lines 29-32) with an expanded note that also covers the structural fields:

```markdown
**Symbol slot ids.** In the symbols-reels doc, give every symbol a stable `slot`
id (`high1`, `high2`, `low1`, `wild`, `scatter`) in its row — this is the durable
handle later chat edits use to reshape that symbol. Set each row's `kind` to one
of: high, low, wild, scatter, bonus.

**Reel structure.** In math-model set `payline_mode` (`lines` or `ways`) and
`payline_count` (e.g. 20 lines, or 243 ways). In symbols-reels set `strip_length`
as a min/max range, e.g. `{"min": 30, "max": 40}` — this is the guardrail the math
tuner optimizes the exact reel length within; do not hand-author the per-symbol
reel composition.
```

- [ ] **Step 2: Format the skill markdown**

Run: `npx prettier --write skills/design-game.md`
Expected: exits 0 (file reformatted or already clean).

- [ ] **Step 3: Run the full backend suite to confirm the skill still loads**

Run: `uv --directory studio/backend run pytest -q`
Expected: PASS. (The skill-registry tests load every skill in `skills/`; editing content with unchanged bound tools keeps them green — re-running the whole suite is the guard the repo's process notes call for after touching a skill file.)

- [ ] **Step 4: Commit**

```bash
git add skills/design-game.md
git commit -m "docs(skill): design-game fills structured payline + strip-length fields"
```

---

### Task 6: Backend e2e — plain chat sets `strip_length` (replay)

**Files:**

- Create: `studio/backend/tests/fixtures/replay/run/route-strip-length.json`
- Create: `studio/backend/tests/e2e/test_gdd_structure_routing.py`

**Interfaces:**

- Consumes: the design-router run path (game-room plain chat → `set_gdd_fields`) and the prompt-keyed replay cassette loader. The replay model selects a cassette by the normalized last human prompt and filters tool_calls to the router's bound tools (which include `set_gdd_fields`).
- Produces: an offline, deterministic service e2e proving a structural edit lands in `data` and renders in `body`.

- [ ] **Step 1: Create the prompt-keyed cassette**

Create `studio/backend/tests/fixtures/replay/run/route-strip-length.json`:

```json
{
  "prompt": "set the reel strip length between 30 and 40",
  "tool_calls": [
    {
      "name": "set_gdd_fields",
      "args": {
        "aspect": "symbols-reels",
        "fields": { "strip_length": { "min": 30, "max": 40 } }
      }
    }
  ],
  "final": ["Set Symbols & Reels → strip length = 30–40."]
}
```

- [ ] **Step 2: Write the failing e2e test**

Create `studio/backend/tests/e2e/test_gdd_structure_routing.py`:

```python
# studio/backend/tests/e2e/test_gdd_structure_routing.py
"""Backend service e2e: structural design intent routes into a typed GDD field.

Plain chat in a game room runs the design-router; a concrete strip-length edit
routes to set_gdd_fields and lands as a structured range. Offline under
PROVIDER_MODE=replay (prompt-keyed cassette route-strip-length.json).
"""
import asyncio

import httpx
import pytest
import socketio


async def _make_room(base_url: str) -> tuple[str, str]:
    async with httpx.AsyncClient(base_url=base_url) as http:
        room = (await http.post("/rooms", json={"name": "StructE2E"})).json()
        return room["id"], room["gameId"]


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_plain_chat_sets_strip_length_range(live_server):
    room_id, game_id = await _make_room(live_server)

    client = socketio.AsyncClient()
    updates: list[dict] = []
    client.on("gdd_doc_updated", lambda d: updates.append(d))

    await client.connect(live_server, auth={"displayName": "Designer"})
    await client.emit("join_room", {"roomId": room_id})
    await client.emit("join_gdd", {"gameId": game_id})
    await asyncio.sleep(0.2)

    await client.emit("send_prompt",
                      {"roomId": room_id,
                       "text": "set the reel strip length between 30 and 40"})

    symbols = None
    async with httpx.AsyncClient(base_url=live_server) as http:
        deadline = asyncio.get_running_loop().time() + 15
        while asyncio.get_running_loop().time() < deadline:
            docs = (await http.get(f"/games/{game_id}/gdd/docs")).json()
            symbols = next((d for d in docs if d["aspect"] == "symbols-reels"), None)
            if symbols and symbols.get("data", {}).get("strip_length"):
                break
            await asyncio.sleep(0.1)

    assert symbols is not None, "symbols-reels doc missing"
    assert symbols["data"]["strip_length"] == {"min": 30.0, "max": 40.0}, \
        f"field not set: {symbols['data']}"
    assert "30–40" in symbols["body"]

    # Viewer reflects it live via gdd_doc_updated for symbols-reels.
    sr_updates = [u for u in updates if u["doc"]["aspect"] == "symbols-reels"]
    assert sr_updates, "no live gdd_doc_updated for symbols-reels"
    assert sr_updates[-1]["doc"]["data"]["strip_length"] == {"min": 30.0, "max": 40.0}

    await client.disconnect()
```

- [ ] **Step 3: Run the e2e to verify it fails for the right reason**

First confirm a replay backend is reachable (the `live_server` fixture / global setup expects one), then:

Run: `uv --directory studio/backend run pytest tests/e2e/test_gdd_structure_routing.py -v -m e2e`
Expected: FAIL initially if run before Tasks 1-2 land (the field/normalizer don't exist). After Tasks 1-4, the failure mode to rule out is a missing cassette or wrong assertion — it should PASS once the schema + normalize + render changes are in.

- [ ] **Step 4: Run the e2e to verify it passes**

Run: `uv --directory studio/backend run pytest tests/e2e/test_gdd_structure_routing.py -v -m e2e`
Expected: PASS — `strip_length` is `{"min": 30.0, "max": 40.0}` in both `data` and the live `gdd_doc_updated`, and `30–40` is in `body`.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/tests/e2e/test_gdd_structure_routing.py \
        studio/backend/tests/fixtures/replay/run/route-strip-length.json
git commit -m "test(gdd): e2e — plain chat sets strip_length range via the router"
```

---

### Task 7: Whole-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full backend unit + e2e suite**

Run: `uv --directory studio/backend run pytest -q`
Expected: PASS — all GDD unit tests, router/store/hub tests, and the new structural e2e. (Confirms removing `paylines`/`reel_strips` broke nothing and the new optional fields left `derive_status` untouched.)

- [ ] **Step 2: Format any touched markdown**

Run: `npx prettier --write "docs/superpowers/**/*.md" skills/design-game.md`
Expected: exits 0; commit if anything changed:

```bash
git add -A && git commit -m "style: prettier on touched markdown" || echo "nothing to format"
```

- [ ] **Step 3: Confirm the branch is clean**

Run: `git status -sb`
Expected: no uncommitted changes; branch `feat/gdd-math-structure` ahead of `main`.

---

## Self-Review (completed)

- **Spec coverage:** §3.1 payline fields → Task 1; §3.2 symbols/strip_length → Task 1; §4 primitives → Task 1; §5 normalization → Task 2; §6 render → Task 3; §7 catalog/router/skill → Tasks 4-5; §8 advisory validation → Tasks 1-2 (warnings only); §9 migration (schema-only, no script) → covered by Task 7 confirming the suite stays green; §10 unit + e2e tests → Tasks 1-6. Every section maps to a task.
- **Placeholder scan:** no TBD/TODO; every code step shows complete code; commands carry expected output.
- **Type consistency:** `Column(key, label, enum)`, `_t` accepting 3-tuples, the `{"min","max"}` range shape, and `field_catalog()`'s `columns` key are defined in Task 1 and consumed unchanged in Tasks 2-6.

# GDD Structured Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the GDD's free-text `body` model with a per-aspect **typed schema** whose structured `data` is the source of truth and whose markdown is rendered — so generated subsections contain concrete, addressable values instead of hollow prose.

**Architecture:** Each of the 7 aspects gets a typed field schema (`gdd/schemas.py`). A doc stores structured `data`; `body` becomes a derived markdown cache produced by a pure renderer (`gdd/render.py`) from values coerced by a normalizer (`gdd/normalize.py`). Status is computed from required-field completeness. The agent edits fields through one workhorse tool, `set_gdd_fields`, and inspects typed gaps through a restructured `read_gdd_doc`. The frontend viewer and socket payload keep carrying `body`, so they are untouched.

**Tech Stack:** Python 3.12, pydantic v2, Motor (async MongoDB), LangChain `StructuredTool`, pytest / pytest-asyncio. Tests run via the backend's existing pytest setup against the shared `mongo_db` fixture.

## Global Constraints

- **Source of truth:** structured `data` is canonical; `body` is a derived cache recomputed on every write; `status` is derived, never hand-set (except the explicit `complete` finalize).
- **Advisory validation:** normalization never raises on bad field values — it returns `(value, warning)` and never blocks a multi-field write.
- **TDD:** every task is RED → GREEN → commit. Write the failing test first, watch it fail, implement minimally, watch it pass.
- **TypeScript interface `I` prefix** rule is repo-wide but this plan touches no TS.
- **Spec reference:** `docs/superpowers/specs/2026-06-24-gdd-structured-content-design.md`.
- **Working directory:** all paths are relative to repo root `C:\code\bloom`. Backend code lives under `studio/backend`. Run pytest from `studio/backend` (e.g. `uv run pytest ...`).
- **Clean cutover:** no migration of legacy free-text docs; `seed_taxonomy` seeds empty structured docs.

---

## Phase 1 — Structured content foundation

### Task 1: Aspect field schemas

**Files:**

- Create: `studio/backend/app/gdd/schemas.py`
- Test: `studio/backend/tests/test_gdd_schemas.py`

**Interfaces:**

- Produces: `FieldType` (Literal), `Role` (Literal), `Column(key, label)` dataclass, `Field(key, label, type, role, required=False, default=None, enum=None, columns=None, help="")` dataclass, `ASPECT_SCHEMAS: dict[str, list[Field]]`, `schema_for(aspect: str) -> list[Field]`, `required_param_keys(aspect: str) -> list[str]`.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_gdd_schemas.py
from app.gdd.schemas import (
    ASPECT_SCHEMAS, schema_for, required_param_keys, Field,
)


def test_all_seven_aspects_have_schemas():
    assert set(ASPECT_SCHEMAS) == {
        "theme", "math-model", "symbols-reels", "paytable",
        "bonus-features", "ui-ux", "audio",
    }
    for fields in ASPECT_SCHEMAS.values():
        assert fields and all(isinstance(f, Field) for f in fields)


def test_math_model_has_required_bonus_hit_rate_ratio():
    fields = {f.key: f for f in schema_for("math-model")}
    assert fields["bonus_hit_rate"].type == "ratio"
    assert fields["bonus_hit_rate"].required is True
    assert fields["rtp"].type == "percent" and fields["rtp"].required
    assert fields["volatility"].type == "enum"
    assert "medium-high" in fields["volatility"].enum


def test_paytable_payouts_is_required_table_with_columns():
    payouts = {f.key: f for f in schema_for("paytable")}["payouts"]
    assert payouts.type == "table" and payouts.required
    assert [c.key for c in payouts.columns] == ["symbol", "3oak", "4oak", "5oak"]


def test_required_param_keys_lists_only_required():
    assert required_param_keys("paytable") == ["payouts"]
    assert set(required_param_keys("math-model")) == {
        "rtp", "volatility", "bonus_hit_rate",
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_gdd_schemas.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.gdd.schemas'`

- [ ] **Step 3: Write minimal implementation**

```python
# studio/backend/app/gdd/schemas.py
from dataclasses import dataclass
from typing import Literal

FieldType = Literal["number", "percent", "ratio", "enum", "text", "table", "list"]
Role = Literal["param", "narrative"]


@dataclass(frozen=True)
class Column:
    key: str
    label: str


@dataclass(frozen=True)
class Field:
    key: str
    label: str
    type: FieldType
    role: Role
    required: bool = False
    default: object | None = None
    enum: tuple[str, ...] | None = None
    columns: tuple[Column, ...] | None = None
    help: str = ""


def _t(*pairs: tuple[str, str]) -> tuple[Column, ...]:
    return tuple(Column(k, l) for k, l in pairs)


ASPECT_SCHEMAS: dict[str, list[Field]] = {
    "theme": [
        Field("name", "Name", "text", "param", required=True),
        Field("setting", "Setting", "text", "param"),
        Field("tone", "Tone", "enum", "param",
              enum=("epic", "playful", "dark", "luxe", "mythic")),
        Field("target_audience", "Target audience", "text", "param"),
        Field("narrative_hook", "Narrative hook", "text", "narrative"),
        Field("art_direction", "Art direction", "text", "narrative"),
    ],
    "math-model": [
        Field("rtp", "RTP", "percent", "param", required=True),
        Field("volatility", "Volatility", "enum", "param", required=True,
              enum=("low", "medium", "medium-high", "high")),
        Field("reels", "Reels", "number", "param", default=5),
        Field("rows", "Rows", "number", "param", default=3),
        Field("paylines", "Paylines / ways", "text", "param"),
        Field("max_win", "Max win (x bet)", "number", "param"),
        Field("hit_frequency", "Hit frequency", "percent", "param"),
        Field("bonus_hit_rate", "Bonus hit rate", "ratio", "param", required=True),
        Field("bet_range", "Bet range", "text", "param"),
    ],
    "symbols-reels": [
        Field("symbols", "Symbols", "table", "param", required=True,
              columns=_t(("name", "Name"), ("kind", "Kind"), ("art_desc", "Art description"))),
        Field("reel_strips", "Reel strips", "table", "param",
              columns=_t(("reel", "Reel"), ("composition", "Composition"))),
        Field("wild_behavior", "Wild behavior", "text", "narrative"),
        Field("scatter_behavior", "Scatter behavior", "text", "narrative"),
    ],
    "paytable": [
        Field("payouts", "Payouts", "table", "param", required=True,
              columns=_t(("symbol", "Symbol"), ("3oak", "3 OAK"),
                         ("4oak", "4 OAK"), ("5oak", "5 OAK"))),
        Field("special_pays", "Special pays", "table", "param",
              columns=_t(("name", "Name"), ("award", "Award"))),
        Field("notes", "Notes", "text", "narrative"),
    ],
    "bonus-features": [
        Field("features", "Features", "table", "param", required=True,
              columns=_t(("name", "Name"), ("trigger", "Trigger"),
                         ("description", "Description"))),
        Field("free_spins", "Free spins", "table", "param",
              columns=_t(("trigger", "Trigger"), ("count", "Count"),
                         ("retrigger", "Retrigger"), ("multiplier", "Multiplier"))),
        Field("bonus_buy", "Bonus buy", "text", "param"),
    ],
    "ui-ux": [
        Field("layout", "Layout", "text", "narrative"),
        Field("key_screens", "Key screens", "list", "param"),
        Field("controls", "Controls", "text", "narrative"),
        Field("quick_spin", "Quick spin", "text", "param"),
        Field("autoplay", "Autoplay", "text", "param"),
    ],
    "audio": [
        Field("music_style", "Music style", "text", "param"),
        Field("sfx", "SFX", "list", "param"),
        Field("dynamic_audio", "Dynamic audio", "text", "narrative"),
    ],
}


def schema_for(aspect: str) -> list[Field]:
    return ASPECT_SCHEMAS[aspect]


def required_param_keys(aspect: str) -> list[str]:
    return [f.key for f in schema_for(aspect) if f.required]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_gdd_schemas.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/gdd/schemas.py studio/backend/tests/test_gdd_schemas.py
git commit -m "feat(gdd): add typed per-aspect field schemas"
```

---

### Task 2: Value normalization

**Files:**

- Create: `studio/backend/app/gdd/normalize.py`
- Test: `studio/backend/tests/test_gdd_normalize.py`

**Interfaces:**

- Consumes: `Field` from `app.gdd.schemas`.
- Produces: `normalize_value(field: Field, raw) -> tuple[object, str | None]` — returns `(coerced_value, warning_or_None)`; never raises.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_gdd_normalize.py
from app.gdd.schemas import Field, Column
from app.gdd.normalize import normalize_value

PERCENT = Field("rtp", "RTP", "percent", "param")
RATIO = Field("bonus_hit_rate", "Bonus hit rate", "ratio", "param")
NUMBER = Field("max_win", "Max win", "number", "param")
ENUM = Field("volatility", "Volatility", "enum", "param",
             enum=("low", "medium", "medium-high", "high"))
TABLE = Field("payouts", "Payouts", "table", "param",
              columns=(Column("symbol", "Symbol"), Column("5oak", "5 OAK")))
LIST = Field("sfx", "SFX", "list", "param")
TEXT = Field("name", "Name", "text", "param")


def test_percent_accepts_percent_string_decimal_and_whole():
    assert normalize_value(PERCENT, "96%") == (0.96, None)
    assert normalize_value(PERCENT, "0.96") == (0.96, None)
    assert normalize_value(PERCENT, 96) == (0.96, None)
    assert normalize_value(PERCENT, 0.96) == (0.96, None)


def test_percent_bad_input_warns_not_raises():
    value, warn = normalize_value(PERCENT, "lots")
    assert value == "lots" and warn is not None


def test_ratio_canonicalizes_to_one_in_n():
    assert normalize_value(RATIO, "1:200") == ("1:200", None)
    assert normalize_value(RATIO, "1 in 200") == ("1:200", None)
    assert normalize_value(RATIO, 200) == ("1:200", None)
    assert normalize_value(RATIO, 0.005) == ("1:200", None)


def test_number_strips_suffix():
    assert normalize_value(NUMBER, "5000x") == (5000.0, None)
    assert normalize_value(NUMBER, 5000) == (5000.0, None)


def test_enum_normalizes_case_and_warns_on_unknown():
    assert normalize_value(ENUM, "High") == ("high", None)
    value, warn = normalize_value(ENUM, "spicy")
    assert value == "spicy" and warn is not None


def test_table_coerces_rows_and_warns_on_missing_columns():
    rows = [{"symbol": "Wild", "5oak": 500}, {"symbol": "Seven"}]
    value, warn = normalize_value(TABLE, rows)
    assert value == [{"symbol": "Wild", "5oak": 500}, {"symbol": "Seven", "5oak": ""}]
    assert warn is not None  # row 1 missing 5oak
    bad, bad_warn = normalize_value(TABLE, "not a list")
    assert bad == "not a list" and bad_warn is not None


def test_list_wraps_scalar_and_passes_list():
    assert normalize_value(LIST, ["a", "b"]) == (["a", "b"], None)
    assert normalize_value(LIST, "solo") == (["solo"], None)


def test_text_passthrough():
    assert normalize_value(TEXT, "Neon Nights") == ("Neon Nights", None)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_gdd_normalize.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.gdd.normalize'`

- [ ] **Step 3: Write minimal implementation**

```python
# studio/backend/app/gdd/normalize.py
import re

from app.gdd.schemas import Field


def normalize_value(field: Field, raw) -> tuple[object, str | None]:
    if field.type == "percent":
        return _percent(raw)
    if field.type == "ratio":
        return _ratio(raw)
    if field.type == "number":
        return _number(raw)
    if field.type == "enum":
        return _enum(field, raw)
    if field.type == "table":
        return _table(field, raw)
    if field.type == "list":
        return _list(raw)
    return (str(raw), None)


def _percent(raw) -> tuple[object, str | None]:
    s = str(raw).strip()
    try:
        v = float(s[:-1]) / 100 if s.endswith("%") else float(s)
        if v > 1:
            v = v / 100
        return (round(v, 4), None)
    except ValueError:
        return (raw, f"could not parse '{raw}' as a percent")


def _ratio(raw) -> tuple[object, str | None]:
    s = str(raw).strip().lower()
    try:
        if ":" in s:
            a, b = s.split(":", 1)
            p = float(a) / float(b)
        elif " in " in s:
            a, b = s.split(" in ", 1)
            p = float(a) / float(b)
        else:
            v = float(s)
            p = v if 0 < v < 1 else 1.0 / v
        if p <= 0:
            raise ValueError
        return (f"1:{round(1 / p)}", None)
    except (ValueError, ZeroDivisionError):
        return (raw, f"could not parse '{raw}' as a ratio (use e.g. '1:200')")


def _number(raw) -> tuple[object, str | None]:
    m = re.search(r"-?\d+(\.\d+)?", str(raw))
    if not m:
        return (raw, f"could not parse '{raw}' as a number")
    return (float(m.group()), None)


def _enum(field: Field, raw) -> tuple[object, str | None]:
    s = str(raw).strip().lower()
    allowed = field.enum or ()
    if s in allowed:
        return (s, None)
    return (s, f"'{raw}' is not one of {list(allowed)} for {field.key}")


def _table(field: Field, raw) -> tuple[object, str | None]:
    cols = [c.key for c in (field.columns or ())]
    if not isinstance(raw, list):
        return (raw, f"{field.key} expects a list of row objects")
    warns: list[str] = []
    rows: list[dict] = []
    for i, row in enumerate(raw):
        if not isinstance(row, dict):
            warns.append(f"{field.key} row {i} is not an object")
            continue
        rows.append({c: row.get(c, "") for c in cols})
        missing = [c for c in cols if c not in row]
        if missing:
            warns.append(f"{field.key} row {i} missing {missing}")
    return (rows, "; ".join(warns) if warns else None)


def _list(raw) -> tuple[object, str | None]:
    if isinstance(raw, list):
        return ([str(x) for x in raw], None)
    if isinstance(raw, str):
        return ([raw], None)
    return (raw, "expected a list")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_gdd_normalize.py -v`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/gdd/normalize.py studio/backend/tests/test_gdd_normalize.py
git commit -m "feat(gdd): add advisory value normalization"
```

---

### Task 3: Markdown renderer

**Files:**

- Create: `studio/backend/app/gdd/render.py`
- Test: `studio/backend/tests/test_gdd_render.py`

**Interfaces:**

- Consumes: `Field`, `schema_for` from `app.gdd.schemas`.
- Produces: `render(schema: list[Field], data: dict) -> str` — pure, deterministic markdown. Groups output as Parameters block → tables → lists → narrative sections (per spec §5).

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_gdd_render.py
from app.gdd.schemas import schema_for
from app.gdd.render import render


def test_paytable_renders_concrete_table():
    schema = schema_for("paytable")
    data = {
        "payouts": [
            {"symbol": "Wild", "3oak": 10, "4oak": 50, "5oak": 500},
            {"symbol": "Seven", "3oak": 5, "4oak": 25, "5oak": 200},
        ],
        "notes": "Wild carries the top end.",
    }
    out = render(schema, data)
    assert "| Symbol | 3 OAK | 4 OAK | 5 OAK |" in out
    assert "| Wild | 10 | 50 | 500 |" in out
    assert "Wild carries the top end." in out


def test_percent_and_ratio_format_in_params_block():
    schema = schema_for("math-model")
    out = render(schema, {"rtp": 0.96, "bonus_hit_rate": "1:200", "max_win": 5000.0})
    assert "**RTP:** 96%" in out
    assert "**Bonus hit rate:** 1:200" in out
    assert "**Max win (x bet):** 5000" in out


def test_missing_required_field_marked_needs_input():
    schema = schema_for("paytable")
    out = render(schema, {"notes": "tbd"})
    assert "needs input" in out.lower()


def test_render_is_deterministic():
    schema = schema_for("math-model")
    data = {"rtp": 0.96, "volatility": "high", "bonus_hit_rate": "1:200"}
    assert render(schema, data) == render(schema, data)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_gdd_render.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.gdd.render'`

- [ ] **Step 3: Write minimal implementation**

```python
# studio/backend/app/gdd/render.py
from app.gdd.schemas import Field

_EMPTY = (None, "", [], {})


def render(schema: list[Field], data: dict) -> str:
    lines: list[str] = []

    scalars = [f for f in schema
               if f.role == "param" and f.type not in ("table", "list")]
    param_lines: list[str] = []
    for f in scalars:
        val = data.get(f.key)
        if val in _EMPTY:
            if f.required:
                param_lines.append(f"- **{f.label}:** ⚠ needs input")
            continue
        param_lines.append(f"- **{f.label}:** {_fmt(f, val)}")
    if param_lines:
        lines.append("**Parameters**")
        lines.extend(param_lines)
        lines.append("")

    for f in (f for f in schema if f.type == "table"):
        lines.append(f"**{f.label}**")
        rows = data.get(f.key)
        if not rows:
            lines.append("⚠ needs input" if f.required else "_none yet_")
        else:
            lines.append(_render_table(f, rows))
        lines.append("")

    for f in (f for f in schema if f.type == "list"):
        lines.append(f"**{f.label}**")
        items = data.get(f.key) or []
        if not items:
            lines.append("_none yet_")
        for it in items:
            lines.append(f"- {it}")
        lines.append("")

    for f in (f for f in schema if f.role == "narrative"):
        val = data.get(f.key)
        lines.append(f"**{f.label}**")
        lines.append(str(val) if val not in _EMPTY else "_(not yet written)_")
        lines.append("")

    return "\n".join(lines).strip() + "\n"


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
    return str(val)


def _render_table(field: Field, rows: list[dict]) -> str:
    cols = field.columns or ()
    header = "| " + " | ".join(c.label for c in cols) + " |"
    sep = "| " + " | ".join("---" for _ in cols) + " |"
    body = [
        "| " + " | ".join(str(row.get(c.key, "")) for c in cols) + " |"
        for row in rows
    ]
    return "\n".join([header, sep, *body])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_gdd_render.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/gdd/render.py studio/backend/tests/test_gdd_render.py
git commit -m "feat(gdd): add deterministic schema-to-markdown renderer"
```

---

### Task 4: Doc `data` field + status derivation

**Files:**

- Modify: `studio/backend/app/gdd/models.py`
- Test: `studio/backend/tests/test_gdd_models.py` (modify existing)

**Interfaces:**

- Consumes: `schema_for` from `app.gdd.schemas`.
- Produces: `GddDoc.data: dict` (default `{}`); `derive_status(aspect: str, data: dict) -> Status`; updated `GDD_TOOL_NAMES` (drops `write_gdd_doc`/`edit_gdd_doc`, adds `set_gdd_fields`).

- [ ] **Step 1: Write the failing test** (replace the body of `test_gdd_models.py` with this)

```python
# studio/backend/tests/test_gdd_models.py
from datetime import datetime, timezone
from app.gdd.models import (
    GddDoc, GDD_TAXONOMY, GDD_TOOL_NAMES, gdd_wire, derive_status,
)


def _doc() -> GddDoc:
    now = datetime(2026, 6, 23, tzinfo=timezone.utc)
    return GddDoc(
        id="d1", game_id="g1", aspect="math-model", title="Math Model",
        order=2, body="RTP 96%", status="drafted", created_at=now, updated_at=now,
    )


def test_taxonomy_is_seven_ordered_aspects():
    aspects = [t["aspect"] for t in GDD_TAXONOMY]
    assert aspects == [
        "theme", "math-model", "symbols-reels", "paytable",
        "bonus-features", "ui-ux", "audio",
    ]
    assert [t["order"] for t in GDD_TAXONOMY] == [1, 2, 3, 4, 5, 6, 7]


def test_gdd_tool_names_are_the_structured_set():
    assert GDD_TOOL_NAMES == {
        "list_gdd_docs", "read_gdd_doc", "set_gdd_fields",
        "set_doc_status", "ask_user_question",
    }


def test_gdd_wire_uses_camelcase_aliases():
    wire = gdd_wire(_doc())
    assert wire["gameId"] == "g1"
    assert wire["aspect"] == "math-model"
    assert wire["status"] == "drafted"
    assert "game_id" not in wire


def test_doc_defaults_to_empty_data():
    assert _doc().data == {}


def test_derive_status_empty_partial_complete():
    assert derive_status("math-model", {}) == "empty"
    # required for math-model: rtp, volatility, bonus_hit_rate
    assert derive_status("math-model", {"rtp": 0.96}) == "needs_input"
    full = {"rtp": 0.96, "volatility": "high", "bonus_hit_rate": "1:200"}
    assert derive_status("math-model", full) == "drafted"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_gdd_models.py -v`
Expected: FAIL — `ImportError: cannot import name 'derive_status'` (and the tool-names/`data` assertions fail).

- [ ] **Step 3: Write minimal implementation** (edit `models.py`)

Add `data` to the model (after the `body` line):

```python
class GddDoc(_WireModel):
    id: str
    game_id: str
    aspect: str
    title: str
    order: int
    data: dict = {}
    body: str = ""
    status: Status = "empty"
    created_at: datetime
    updated_at: datetime
```

Replace the `GDD_TOOL_NAMES` set with:

```python
GDD_TOOL_NAMES: set[str] = {
    "list_gdd_docs", "read_gdd_doc", "set_gdd_fields",
    "set_doc_status", "ask_user_question",
}
```

Add the derivation helper and import at the top of the file (add the import after the existing `from typing import Literal`):

```python
from app.gdd.schemas import schema_for
```

```python
def derive_status(aspect: str, data: dict) -> Status:
    if not data:
        return "empty"
    schema = schema_for(aspect)
    missing = [
        f.key for f in schema
        if f.required and data.get(f.key) in (None, "", [], {})
    ]
    return "needs_input" if missing else "drafted"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_gdd_models.py -v`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/gdd/models.py studio/backend/tests/test_gdd_models.py
git commit -m "feat(gdd): add structured data field and derived status"
```

---

### Task 5: Store `set_fields` + drop string-edit path

**Files:**

- Modify: `studio/backend/app/gdd/store.py`
- Test: `studio/backend/tests/test_gdd_store.py` (modify existing)

**Interfaces:**

- Consumes: `schema_for` (`app.gdd.schemas`), `normalize_value` (`app.gdd.normalize`), `render` (`app.gdd.render`), `derive_status` (`app.gdd.models`).
- Produces: `GddStore.set_fields(game_id, aspect, fields: dict) -> tuple[GddDoc, list[str]]`. Removes `GddStore.edit_doc`. Keeps `upsert_doc`, `set_status`, `seed_taxonomy`, `list_docs`, `get_doc`, and `GddEditError`.

- [ ] **Step 1: Write the failing test** (replace the two `edit_doc` tests in `test_gdd_store.py` — `test_edit_doc_replaces_unique_block` and `test_edit_doc_raises_when_missing_or_ambiguous` — with the `set_fields` tests below; keep the other existing tests)

```python
# add to studio/backend/tests/test_gdd_store.py (and delete the two edit_doc tests)
@pytest.mark.asyncio
async def test_set_fields_normalizes_renders_and_derives_status(mongo_db):
    store = GddStore(mongo_db)
    await store.seed_taxonomy("g1")
    doc, warnings = await store.set_fields(
        "g1", "math-model",
        {"rtp": "96%", "volatility": "High", "bonus_hit_rate": "1 in 200"},
    )
    assert warnings == []
    assert doc.data["rtp"] == 0.96
    assert doc.data["volatility"] == "high"
    assert doc.data["bonus_hit_rate"] == "1:200"
    assert doc.status == "drafted"          # all required present
    assert "**RTP:** 96%" in doc.body       # body is rendered from data


@pytest.mark.asyncio
async def test_set_fields_is_surgical_and_keeps_untouched_fields(mongo_db):
    store = GddStore(mongo_db)
    await store.seed_taxonomy("g1")
    await store.set_fields("g1", "math-model", {"rtp": "96%"})
    doc, _ = await store.set_fields("g1", "math-model", {"volatility": "low"})
    assert doc.data["rtp"] == 0.96          # earlier field untouched
    assert doc.data["volatility"] == "low"
    assert doc.status == "needs_input"      # bonus_hit_rate still missing


@pytest.mark.asyncio
async def test_set_fields_warns_on_unknown_field_without_blocking(mongo_db):
    store = GddStore(mongo_db)
    await store.seed_taxonomy("g1")
    doc, warnings = await store.set_fields(
        "g1", "math-model", {"rtp": "96%", "made_up": "x"},
    )
    assert doc.data["rtp"] == 0.96          # valid field still applied
    assert any("made_up" in w for w in warnings)
    assert "made_up" not in doc.data


@pytest.mark.asyncio
async def test_set_fields_raises_when_aspect_unseeded(mongo_db):
    store = GddStore(mongo_db)
    with pytest.raises(GddEditError):
        await store.set_fields("g1", "math-model", {"rtp": "96%"})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_gdd_store.py -v`
Expected: FAIL — `AttributeError: 'GddStore' object has no attribute 'set_fields'`

- [ ] **Step 3: Write minimal implementation**

In `store.py`, update imports at the top:

```python
from app.gdd.models import GDD_TAXONOMY, GddDoc, Status, derive_status
from app.gdd.schemas import schema_for
from app.gdd.normalize import normalize_value
from app.gdd.render import render
```

Delete the entire `edit_doc` method (the `async def edit_doc(...)` block). Then add `set_fields`:

```python
    async def set_fields(
        self, game_id: str, aspect: str, fields: dict
    ) -> tuple[GddDoc, list[str]]:
        doc = await self.get_doc(game_id, aspect)
        if doc is None:
            raise GddEditError(
                f"No GDD doc for ({game_id}, {aspect}); seed the taxonomy first."
            )
        schema = schema_for(aspect)
        by_key = {f.key: f for f in schema}
        new_data = dict(doc.data)
        warnings: list[str] = []
        for key, raw in fields.items():
            field = by_key.get(key)
            if field is None:
                warnings.append(f"unknown field '{key}' for aspect '{aspect}'")
                continue
            value, warn = normalize_value(field, raw)
            if warn:
                warnings.append(warn)
            new_data[key] = value
        status = derive_status(aspect, new_data)
        body = render(schema, new_data)
        await self._docs.update_one(
            {"game_id": game_id, "aspect": aspect},
            {"$set": {
                "data": new_data, "body": body, "status": status,
                "updated_at": _now().isoformat(),
            }},
        )
        updated = await self.get_doc(game_id, aspect)
        assert updated is not None
        return updated, warnings
```

> Note: `GddEditError` is retained (still raised by `set_fields` and `upsert_doc`). The docstring on `GddEditError` mentioning `edit_doc` may be left as-is or trimmed; no behavior depends on it.

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_gdd_store.py -v`
Expected: PASS (all remaining tests, including the 4 new `set_fields` tests)

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/gdd/store.py studio/backend/tests/test_gdd_store.py
git commit -m "feat(gdd): add set_fields store path, drop string-edit"
```

---

### Task 6: Hub `set_fields` + drop write/edit emit methods

**Files:**

- Modify: `studio/backend/app/gdd/hub.py`
- Test: `studio/backend/tests/test_gdd_hub.py` (modify existing)

**Interfaces:**

- Consumes: `GddStore.set_fields`.
- Produces: `GddHub.set_fields(game_id, aspect, fields: dict) -> tuple[GddDoc, list[str]]` (persists via store, emits `gdd_doc_updated`). Removes `GddHub.write_doc` and `GddHub.edit_doc`. Keeps `seed_taxonomy`, `set_status`, `attach`, `_emit_updated`.

- [ ] **Step 1: Write the failing test** (replace `test_write_doc_persists_and_emits_update` in `test_gdd_hub.py` with the test below; keep `test_attach_enters_room_and_sends_snapshot`)

```python
@pytest.mark.asyncio
async def test_set_fields_persists_and_emits_update(mongo_db):
    sio, store = FakeSio(), GddStore(mongo_db)
    hub = GddHub(sio, store)
    await hub.seed_taxonomy("g1")
    doc, warnings = await hub.set_fields(
        "g1", "math-model",
        {"rtp": "96%", "volatility": "high", "bonus_hit_rate": "1:200"},
    )
    assert warnings == [] and doc.status == "drafted"
    events = [e for e in sio.emitted if e[0] == "gdd_doc_updated"]
    last = events[-1]
    assert last[1]["gameId"] == "g1"
    assert last[1]["doc"]["aspect"] == "math-model"
    assert last[2] == "g1"  # room
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_gdd_hub.py -v`
Expected: FAIL — `AttributeError: 'GddHub' object has no attribute 'set_fields'`

- [ ] **Step 3: Write minimal implementation**

In `hub.py`, delete the `write_doc` and `edit_doc` methods and add:

```python
    async def set_fields(
        self, game_id: str, aspect: str, fields: dict
    ) -> tuple[GddDoc, list[str]]:
        doc, warnings = await self._store.set_fields(game_id, aspect, fields)
        await self._emit_updated(game_id, doc)
        return doc, warnings
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_gdd_hub.py -v`
Expected: PASS (both tests)

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/gdd/hub.py studio/backend/tests/test_gdd_hub.py
git commit -m "feat(gdd): add hub set_fields, drop write/edit emit methods"
```

---

### Task 7: Agent tools — structured `read_gdd_doc` + `set_gdd_fields`

**Files:**

- Modify: `studio/backend/app/agent_tools.py`
- Test: `studio/backend/tests/test_gdd_tools.py` (rewrite), `studio/backend/tests/test_agent_tools.py` (modify the known-tools assertion)

**Interfaces:**

- Consumes: `GddHub.set_fields`, `GddStore.get_doc`, `schema_for`.
- Produces: `build_read_gdd_doc_tool` (returns structured field/gap listing), `build_set_gdd_fields_tool` (field patch). `ToolFactory._BUILDERS` drops `write_gdd_doc`/`edit_gdd_doc`, adds `set_gdd_fields`.

- [ ] **Step 1: Write the failing test** (replace the whole body of `test_gdd_tools.py` with this)

```python
# studio/backend/tests/test_gdd_tools.py
import pytest
from app.agent_tools import ToolContext, ToolFactory
from app.gdd.hub import GddHub
from app.gdd.store import GddStore


def _ctx(store, hub):
    return ToolContext(room_id="r1", game_id="g1", asset_store=None,
                       asset_hub=None, gdd_store=store, gdd_hub=hub)


class _SilentSio:
    async def emit(self, *a, **k): ...
    async def enter_room(self, *a, **k): ...


def _factory(store, hub):
    return ToolFactory(asset_store=None, asset_hub=None, gdd_store=store, gdd_hub=hub)


@pytest.fixture(autouse=True)
async def _clean_gdd_docs(mongo_db):
    await mongo_db["gdd_docs"].delete_many({})
    yield
    await mongo_db["gdd_docs"].delete_many({})


@pytest.mark.asyncio
async def test_set_gdd_fields_then_read_reports_gaps(mongo_db):
    store = GddStore(mongo_db)
    hub = GddHub(_SilentSio(), store)
    await store.seed_taxonomy("g1")
    factory = _factory(store, hub)
    ctx = _ctx(store, hub)

    setter = factory.build(["set_gdd_fields"], ctx)[0]
    msg = await setter.ainvoke(
        {"aspect": "math-model", "fields": {"rtp": "96%", "volatility": "high"}}
    )
    assert "math-model" in msg
    assert (await store.get_doc("g1", "math-model")).data["rtp"] == 0.96

    reader = factory.build(["read_gdd_doc"], ctx)[0]
    view = await reader.ainvoke({"aspect": "math-model"})
    # bonus_hit_rate is required and still empty -> surfaced as a gap
    assert "bonus_hit_rate" in view
    assert "missing required" in view.lower()


@pytest.mark.asyncio
async def test_set_gdd_fields_writes_a_table(mongo_db):
    store = GddStore(mongo_db)
    hub = GddHub(_SilentSio(), store)
    await store.seed_taxonomy("g1")
    ctx = _ctx(store, hub)
    setter = _factory(store, hub).build(["set_gdd_fields"], ctx)[0]
    await setter.ainvoke({"aspect": "paytable", "fields": {"payouts": [
        {"symbol": "Wild", "3oak": 10, "4oak": 50, "5oak": 500},
    ]}})
    body = (await store.get_doc("g1", "paytable")).body
    assert "| Wild | 10 | 50 | 500 |" in body


@pytest.mark.asyncio
async def test_set_gdd_fields_reports_warnings(mongo_db):
    store = GddStore(mongo_db)
    hub = GddHub(_SilentSio(), store)
    await store.seed_taxonomy("g1")
    ctx = _ctx(store, hub)
    setter = _factory(store, hub).build(["set_gdd_fields"], ctx)[0]
    msg = await setter.ainvoke(
        {"aspect": "math-model", "fields": {"made_up": "x"}}
    )
    assert "warning" in msg.lower() and "made_up" in msg
```

Also update `test_agent_tools.py` (the `known_tool_names()` assertion) to:

```python
    assert f.known_tool_names() == {
        "generate_asset", "list_assets", "delete_asset",
        "list_gdd_docs", "read_gdd_doc", "set_gdd_fields",
        "set_doc_status", "ask_user_question",
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_gdd_tools.py tests/test_agent_tools.py -v`
Expected: FAIL — `set_gdd_fields` builder missing; `known_tool_names` mismatch.

- [ ] **Step 3: Write minimal implementation**

In `agent_tools.py`: delete `build_write_gdd_doc_tool` and `build_edit_gdd_doc_tool`. Replace `build_read_gdd_doc_tool` with the structured version and add `build_set_gdd_fields_tool`:

```python
def build_read_gdd_doc_tool(ctx: ToolContext) -> BaseTool:
    async def read_gdd_doc(aspect: str) -> str:
        from app.gdd.schemas import schema_for
        doc = await ctx.gdd_store.get_doc(ctx.game_id, aspect)
        if doc is None:
            return f"No GDD doc for aspect '{aspect}'."
        schema = schema_for(aspect)
        lines = [f"aspect={aspect} status={doc.status}", "fields:"]
        for f in schema:
            filled = doc.data.get(f.key) not in (None, "", [], {})
            req = " required" if f.required else ""
            lines.append(f"- {f.key} [{f.type}{req}]: {'set' if filled else 'EMPTY'}")
        missing = [
            f.key for f in schema
            if f.required and doc.data.get(f.key) in (None, "", [], {})
        ]
        if missing:
            lines.append("missing required: " + ", ".join(missing))
        return "\n".join(lines)

    return StructuredTool.from_function(
        coroutine=read_gdd_doc, name="read_gdd_doc",
        description="Read one GDD aspect's structured fields and status. Shows each "
                    "field key, type, whether it is set, and which required fields are "
                    "still empty. Call before set_gdd_fields to learn the field keys.",
    )


def build_set_gdd_fields_tool(ctx: ToolContext) -> BaseTool:
    async def set_gdd_fields(aspect: str, fields: dict) -> str:
        try:
            doc, warnings = await ctx.gdd_hub.set_fields(ctx.game_id, aspect, fields)
        except GddEditError as e:
            return f"Could not update '{aspect}': {e}"
        msg = (f"Updated '{aspect}' ({', '.join(fields.keys())}); "
               f"status now {doc.status}.")
        if warnings:
            msg += " Warnings: " + "; ".join(warnings)
        return msg

    return StructuredTool.from_function(
        coroutine=set_gdd_fields, name="set_gdd_fields",
        description="Set one or more typed fields on a GDD aspect. 'fields' maps field "
                    "keys to values: numbers, percents ('96%'), ratios ('1:200'), enums, "
                    "lists, or table fields as a list of row objects (one key per column). "
                    "Only the keys you pass change. Read the doc first for the field keys.",
    )
```

Update `ToolFactory._BUILDERS` — remove the `write_gdd_doc` and `edit_gdd_doc` entries, add `set_gdd_fields`:

```python
    _BUILDERS = {
        "generate_asset": build_generate_asset_tool,
        "list_assets": build_list_assets_tool,
        "delete_asset": build_delete_asset_tool,
        "list_gdd_docs": build_list_gdd_docs_tool,
        "read_gdd_doc": build_read_gdd_doc_tool,
        "set_gdd_fields": build_set_gdd_fields_tool,
        "set_doc_status": build_set_doc_status_tool,
        "ask_user_question": build_ask_user_question_tool,
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_gdd_tools.py tests/test_agent_tools.py -v`
Expected: PASS

- [ ] **Step 5: Run the full backend unit suite to catch stragglers**

Run: `uv run pytest -q`
Expected: PASS. If any test still imports `write_gdd_doc`/`edit_gdd_doc` or `hub.write_doc`/`store.edit_doc`, update it to the structured API (they should already be covered by Tasks 4–7).

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/tests/test_gdd_tools.py studio/backend/tests/test_agent_tools.py
git commit -m "feat(gdd): structured read_gdd_doc and set_gdd_fields tools"
```

---

## Phase 2 — Generation

### Task 8: Rewrite the `design-game` skill to fill the typed form

**Files:**

- Modify: `skills/design-game.md`
- Test: `studio/backend/tests/test_skills_registry.py` (add a focused assertion; create the file if the project has no registry test — see Step 1)

**Interfaces:**

- Consumes: the structured tools from Task 7. The skill's `tools:` list must reference only names in `GDD_TOOL_NAMES` (Task 4), or `SkillRegistry.load()` raises `SkillError`.

- [ ] **Step 1: Write the failing test**

First check for an existing registry test:

Run: `uv run pytest -q -k skill` and look for a registry/load test. If `studio/backend/tests/test_skills_registry.py` does not exist, create it:

```python
# studio/backend/tests/test_skills_registry.py
from pathlib import Path
from app.skills import SkillRegistry
from app.gdd.models import GDD_TOOL_NAMES

# The real tool universe also includes the asset tools; design-game only needs GDD ones.
_KNOWN = GDD_TOOL_NAMES | {"generate_asset", "list_assets", "delete_asset"}


def test_design_game_skill_loads_with_structured_tools():
    reg = SkillRegistry(Path(__file__).resolve().parents[2] / "skills", _KNOWN)
    reg.load()  # raises SkillError if design-game references an unknown tool
    spec = reg.get("design-game")
    assert spec is not None
    assert "set_gdd_fields" in spec.tools
    assert "write_gdd_doc" not in spec.tools
    assert "edit_gdd_doc" not in spec.tools
```

> Path note: `skills/` is at the repo root; `tests/` is under `studio/backend`, so the skills dir is `parents[2]` from the test file (`tests` → `backend` → `studio` → repo root). Verify by running the test; if the path is wrong the `spec is None` assertion will fail fast — adjust `parents[N]` accordingly.

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_skills_registry.py -v`
Expected: FAIL — current `design-game.md` still lists `write_gdd_doc`/`edit_gdd_doc`, so `set_gdd_fields not in spec.tools` (and the `_KNOWN` set no longer contains `write_gdd_doc`, so `reg.load()` raises `SkillError`).

- [ ] **Step 3: Write minimal implementation** — replace `skills/design-game.md` entirely with:

```markdown
---
name: design-game
description: Draft the game's Game Design Document from your description, then
  interview you to resolve the highest-impact gaps until the design is solid.
args:
  - { name: focus, type: string, required: false, description: 'Optionally target one aspect (e.g. math-model).' }
tools: [list_gdd_docs, read_gdd_doc, set_gdd_fields, set_doc_status, ask_user_question]
---

You are designing a casino slot game with the user. The GDD is a fixed set of
docs, one per aspect: theme, math-model, symbols-reels, paytable, bonus-features,
ui-ux, audio. Each doc is a TYPED FORM — a set of named fields — not free prose.
Empty docs for every aspect already exist.

Your job is to FILL THE FORM with concrete, specific values. Never describe what a
section "will contain"; write the actual content. A paytable is a table of real
payout numbers, not a sentence about payouts.

Work in this order:

1. DRAFT-ALL. For each aspect, call `read_gdd_doc` to see its field keys and which
   are required, then call `set_gdd_fields` to fill EVERY field with a concrete
   value. Pass real values: percents like "96%", ratios like "1:200", and table
   fields as a list of row objects (one key per column — e.g. payouts rows of
   {symbol, 3oak, 4oak, 5oak}). Where the user did not specify something, choose a
   sensible, industry-typical default rather than leaving it blank or vague. Status
   is derived automatically from the required fields you fill.

2. RANK GAPS. Call `list_gdd_docs` and review which decisions are still assumed
   defaults rather than user choices. Order them by how much they materially shape
   the game: RTP, volatility, bonus trigger / hit rate, and reel/payline structure
   rank high; flavour wording ranks low.

3. INTERVIEW — one question at a time. For the single highest-impact gap, call
   `ask_user_question` with a crisp question and 2-4 concrete, opinionated casino
   choices (never open-ended "what do you want?"). When the answer arrives, apply
   it with `set_gdd_fields` to the specific field(s) it affects. If the user
   delegates, pick the best option yourself and keep going. Re-rank and continue.
   Ask only about material gaps; never re-ask something already answered.

4. FINALIZE. When no material gaps remain, call `set_doc_status` "complete" for the
   resolved docs and summarise in one short message what was decided and which
   defaults you assumed.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_skills_registry.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add skills/design-game.md studio/backend/tests/test_skills_registry.py
git commit -m "feat(gdd): rewrite design-game skill to fill typed fields"
```

---

### Task 9: E2e — design-game produces concrete content

**Files:**

- Modify: `studio/backend/tests/e2e/test_gdd.py`
- Refresh: replay cassette(s) for the rewritten design-game flow

**Interfaces:**

- Consumes: the full structured stack (Tasks 1–8) running under a live/replay backend on `:8000`.

> This is browser-free backend e2e. Per repo policy it is CI-affordable and runs against a replay backend. The LLM output is non-deterministic, so assertions check structural concreteness, not exact text.

- [ ] **Step 1: Add the failing assertion** — extend `test_design_game_seeds_docs_and_asks_a_question` (after the existing 7-docs assertion) with a concreteness check on the paytable:

```python
    # 3. Concreteness: once drafted, the paytable doc must contain a real markdown
    #    table (numeric payout rows), not hollow "to be determined" prose.
    paytable = next(d for d in docs if d["aspect"] == "paytable")
    body = paytable["body"]
    lowered = body.lower()
    assert "to be determined" not in lowered
    assert "will outline" not in lowered
    # A rendered table has header pipes and at least one data row.
    assert body.count("|") >= 8, f"paytable has no table rows:\n{body}"
```

> If the design-game run has not necessarily drafted the paytable by the time the
> first question interrupt fires, poll the REST docs endpoint until
> `paytable.status` is no longer `empty` (reuse the existing deadline-poll pattern
> in the test, polling `GET /games/{game_id}/gdd/docs`) before asserting.

- [ ] **Step 2: Run to verify it fails (or needs a fresh cassette)**

Start a replay backend, then run the e2e:

```bash
# terminal 1
just backend-serve-replay
# terminal 2
cd studio/backend && uv run pytest tests/e2e/test_gdd.py -v -m e2e
```

Expected: FAIL — either the stale cassette still yields the old hollow body, or the new tool calls have no recorded turns.

- [ ] **Step 3: Re-record the cassette from live providers**

```bash
just record-fixtures        # or the project's targeted record command for design-game
```

Confirm a fresh cassette covering the `design-game` flow with `set_gdd_fields` tool calls is written under the replay fixtures directory.

- [ ] **Step 4: Run to verify it passes**

```bash
cd studio/backend && uv run pytest tests/e2e/test_gdd.py -v -m e2e
```

Expected: PASS — 7 docs seeded, a question interrupt fired, and the paytable body contains a real numeric table.

- [ ] **Step 5: Prettier-check any changed spec/test files the repo gates**

Run: `npx prettier --check "studio/backend/tests/e2e/test_gdd.py"` is not applicable (Python). Instead confirm no markdown/TS files changed need formatting:

Run: `npx prettier --check .` from repo root and fix anything it flags with `--write`.

- [ ] **Step 6: Commit**

```bash
git add studio/backend/tests/e2e/test_gdd.py studio/backend/app/replay
git commit -m "test(gdd): e2e asserts design-game drafts a concrete paytable"
```

---

## Phase 3 — Intent routing (Problem A): separate follow-up plan

Problem A (freeform chat like _"set the bonus hit rate to 1:200"_ routing to a
`set_gdd_fields` call without an explicit `/design-game`) is **intentionally not in
this plan.** Reasons:

1. It is an independent subsystem that **depends on** this one — its router prompt
   consumes a `field_catalog()` built from the schemas delivered here.
2. Its riskiest change is wiring `room_hub`'s plain-chat path to run a synthetic
   "design-router" skill spec through `TurnRunner` instead of the no-tool branch.
   That code should be written against the **merged** Phase 1–2 code, not a moving
   target.

After this plan merges, write `docs/superpowers/plans/<date>-gdd-intent-routing.md`
covering: `field_catalog()` in `gdd/schemas.py`; a `build_design_router_spec()`
that produces a `SkillSpec` (system prompt seeded with the catalog + GDD tool
allowlist); a `room_hub` change to route game-room plain chat through `_run_skill`
with that spec; disambiguation via `ask_user_question`; and e2e for the routed edit
plus a re-recorded cassette.

---

## Self-Review

**Spec coverage (Problem B sections):**

- §3 architecture (data canonical, body cached, viewer untouched) → Tasks 4–6 (data field, store/hub set_fields render body), confirmed by tests asserting `body` is rendered.
- §4.1 doc shape (`data`, derived `body`, derived `status`) → Task 4 + Task 5.
- §4.2 schema/fields (`Field`, `Column`, `role`, `table` columns) → Task 1.
- §4.3 the 7 aspect schemas → Task 1 (`ASPECT_SCHEMAS`).
- §4.4 status derivation → Task 4 (`derive_status`).
- §5 renderer (params block, tables, lists, narrative, needs-input markers) → Task 3.
- §6 tool surface (`read_gdd_doc` structured, `set_gdd_fields`, drop write/edit) → Task 7; `list_gdd_docs`/`set_doc_status` retained.
- §7 design-game generation flow → Task 8.
- §9 module changes (`schemas.py`, `render.py`, `normalize.py`, `models.py`, `store.py`, `hub.py`, `agent_tools.py`, `design-game.md`) → Tasks 1–8. (`room_hub.py` change is Problem A → Phase 3 follow-up plan, per the deferral.)
- §10 clean cutover → no migration task; `seed_taxonomy` seeds empty `data` (Task 5 relies on existing seeding; `data` defaults to `{}` via Task 4).
- §12 testing (normalize, render, status, set_fields, catalog, e2e concrete paytable) → Tasks 2, 3, 4, 5, 9. (`field_catalog` test → Phase 3 plan.)
- §8 intent routing → explicitly deferred to the Phase 3 follow-up plan.

**Placeholder scan:** no TBD/TODO; every code step shows complete code; commands have expected output. The only non-code manual steps are cassette recording (Task 9), which is inherently an environment action with an explicit command.

**Type consistency:** `set_fields` returns `tuple[GddDoc, list[str]]` in store (Task 5), hub (Task 6), and is consumed by `set_gdd_fields` (Task 7) — consistent. `derive_status(aspect, data)` signature is identical in Task 4 (definition), Task 5 (store import/use). `normalize_value(field, raw) -> (value, warning)` is consistent across Task 2 (def), Task 5 (use). `render(schema, data)` consistent Task 3 / Task 5. `GDD_TOOL_NAMES` value set is identical in Task 4 (models) and the `design-game.md` `tools:` list (Task 8) and the `known_tool_names()` assertion (Task 7).

---

## Execution Handoff

Recommended: **subagent-driven** — fresh implementer subagent per task, review between tasks. Tasks 1–3 are independent pure modules (parallelizable); Tasks 4–7 are sequential (each imports the prior); Tasks 8–9 close out generation.

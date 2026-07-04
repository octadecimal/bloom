# Unified Math Backend (`app/math`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge `app/simulator` + `app/tuner` + `app/analytics` into one `app/math` backend module with one unified `slot_models` document (tuner params + locks folded in), template seeding so a game's model is never `{}`, and a backend-owned generate pipeline (tune → verify → persist verdict) — while preserving every existing REST route, socket event name, and agent-tool contract.

**Architecture:** Sub-project 1 of `docs/superpowers/specs/2026-07-03-math-consolidation-design.md`. New `app/math` code is built alongside the old modules (Tasks 1–4), then one flip task (Task 5) rewires `main.py`/`RoomHub`/`agent_tools`/scene and deletes the old packages. The existing test suite is the migration's regression net.

**Tech Stack:** FastAPI + python-socketio + Motor/Mongo + pydantic v2 (camelCase wire aliases), Rust binaries (`bloom-simulator` curate_json, `bloom-tuner` tune_json) driven via subprocess runners, Playwright e2e.

## Global Constraints

- **Worktree:** all work happens in `C:\code\bloom.wt\math-consolidation` on branch `feat/math-consolidation`. Never touch the primary checkout.
- **Ports:** this worktree has `BLOOM_PORT_OFFSET=1` (in its `.env`): backend **:8001**, studio frontend **:4201**, runtime client **:4301**, Mongo db `bloom_studio_wt1`. NEVER use the default `:8000/:4200/:4300` — another session may hold them. Export `BLOOM_PORT_OFFSET=1` in any shell running servers or Playwright.
- **Bootstrap once** before the first task: `cd C:\code\bloom.wt\math-consolidation && just bootstrap` (npm install + uv sync). Mongo must be running (`just mongo-up` if not).
- **Route/event/tool freeze:** every existing REST route path, response shape, and socket event name is preserved. Agent tool **names and return-text strings stay byte-identical** — replay run-cassettes are prompt-keyed, and tool output feeds subsequent prompts.
- **Test commands:** backend unit gate = `cd studio/backend && uv run pytest -m "not e2e"`; binary/e2e-marked = `uv run pytest -m e2e`; single file = `uv run pytest tests/test_x.py -v`.
- **Wire models** use pydantic v2 with `alias_generator=to_camel, populate_by_name=True` (the `_WireModel` pattern). Mongo persists snake_case (`model_dump(mode="json")`); HTTP/socket wires are camelCase (`by_alias=True`).
- **Commits:** semantic format, one commit per task (or per step where marked).
- **Prettier:** use the pinned binary `node_modules/.bin/prettier` (never `npx prettier`) for any markdown/TS formatting.
- **Repo-root resolution gotcha:** files under `app/<pkg>/x.py` compute `_REPO_ROOT = Path(__file__).resolve().parents[4]`. Files moved one level deeper (`app/math/runners/x.py`) must use `parents[5]`.

## File Structure (end state)

```
studio/backend/app/math/
  __init__.py
  models.py      # all wire models (merged sim+tuner+analytics) + SectionLocks + unified SlotModelDoc
  templates.py   # classic-3x3 / video-5x3 (default) / high-vol-5x4 + apply_template
  store.py       # MathStore (SoT, was SlotModelStore) + MathRunStore + lazy tuner_jobs migration
  targets.py     # derive_target (moved from simulator)
  bounds.py      # GA bounds/config (moved from tuner)
  realize.py     # GDD->SlotModel realizer (moved from simulator)
  hub.py         # MathHub — curation + tune + analytics record + generate pipeline
  rest.py        # ALL existing sim/tuner/analytics routes + templates + generate
  sockets.py     # join_sim/join_tuner/join_analytics handlers (names preserved)
  runners/
    __init__.py
    curate.py    # was app/simulator/runner.py
    tune.py      # was app/tuner/runner.py
studio/backend/tools/freeze_template.py   # one-shot template tuner
```

Deleted at Task 5: `app/simulator/`, `app/tuner/`, `app/analytics/` (all files), `DEMO_SLOT_MODEL` in `app/scene/reels_spin.py`.

---

### Task 1: Unified wire models — `app/math/models.py`

**Files:**

- Create: `studio/backend/app/math/__init__.py` (empty)
- Create: `studio/backend/app/math/models.py`
- Test: `studio/backend/tests/test_math_models.py`

**Interfaces:**

- Consumes: nothing (leaf module).
- Produces: everything later tasks import from `app.math.models`: `CurationParams`, `MetricsWire`, `CurationResult`, `TuneWeights`, `TuningParams`, `BandMissWire`, `PopulationStatsWire`, `HistogramBinWire`, `WinDistributionWire`, `TailWire`, `RtpPointWire`, `RunProfileWire`, `GenSnapshotWire`, `TuneResult`, `SectionLocks`, `SlotModelDoc` (unified), `MathRunDoc` (with `verify`), `TUNER_TOOL_NAMES`, `default_params()`, `default_tuning_params()`, `sim_wire(doc)`, `tuner_view(doc)`, `math_run_wire(doc)`.

- [ ] **Step 1: Write the failing tests**

`studio/backend/tests/test_math_models.py`:

```python
"""Unified wire models. Merges the coverage of the old test_sim_models /
test_tuner_models / test_analytics_models (those files are deleted in Task 5)."""
from app.math.models import (
    SlotModelDoc, SectionLocks, MathRunDoc, TuneResult, MetricsWire,
    GenSnapshotWire, TailWire, HistogramBinWire, CurationResult,
    default_params, default_tuning_params, sim_wire, tuner_view, math_run_wire,
    TUNER_TOOL_NAMES,
)


def _metrics() -> MetricsWire:
    return MetricsWire(rtp=0.96, volatility=4.2, hit_frequency=0.3,
                       base_rtp=0.8, feature_rtp=0.16, bonus_hit_rates=[0.006])


def _doc(**over) -> SlotModelDoc:
    base = dict(id="d1", game_id="g1", model={"rows": 3}, params=default_params(),
                created_at="t0", updated_at="t1")
    base.update(over)
    return SlotModelDoc.model_validate(base)


def test_unified_doc_defaults_new_fields():
    doc = _doc()
    assert doc.tuner_params == default_tuning_params()
    assert doc.locks == SectionLocks()
    assert doc.locks.reels is False and doc.locks.paytable is False and doc.locks.bonus is False
    assert doc.tune_result is None
    assert doc.presentation == {}
    assert doc.result is None


def test_legacy_shaped_doc_still_validates():
    # A doc written before this change has none of the new keys.
    raw = {"id": "d1", "game_id": "g1", "model": {}, "params":
           default_params().model_dump(mode="json"),
           "created_at": "t0", "updated_at": "t1"}
    doc = SlotModelDoc.model_validate(raw)
    assert doc.tuner_params.population == 24


def test_sim_wire_is_camel_and_excludes_tune_result():
    tr = TuneResult(status="pass", verdict="pass", tuned_model={"rows": 3},
                    metrics=_metrics(), ran_at="t2")
    wire = sim_wire(_doc(tune_result=tr))
    assert wire["gameId"] == "g1"
    assert "tunerParams" in wire and "locks" in wire
    assert "tuneResult" not in wire  # editor wire stays slim; /tuner carries it


def test_tuner_view_synthesizes_legacy_tuner_wire():
    tr = TuneResult(status="near_miss", verdict="near_miss",
                    tuned_model={"rows": 3}, metrics=_metrics(), ran_at="t2")
    view = tuner_view(_doc(tune_result=tr))
    assert set(view) == {"id", "gameId", "params", "result", "createdAt", "updatedAt"}
    assert view["params"]["maxGenerations"] == 40
    assert view["result"]["tunedModel"] == {"rows": 3}
    assert view["result"]["metrics"]["hitFrequency"] == 0.3


def test_tuner_view_with_no_result():
    assert tuner_view(_doc())["result"] is None


def test_math_run_doc_carries_optional_verify():
    run = MathRunDoc(id="r1", game_id="g1", params=default_tuning_params(),
                     created_at="t0")
    assert run.verify is None
    verified = MathRunDoc(id="r2", game_id="g1", params=default_tuning_params(),
                          verify=CurationResult(status="pass", metrics=_metrics(),
                                                ran_at="t3"),
                          created_at="t0")
    wire = math_run_wire(verified)
    assert wire["verify"]["status"] == "pass"


def test_tail_wire_pge100x_alias_round_trip():
    tail = TailWire(max_win=500.0, **{"pGE100x": 0.001},
                    p_losing_spin=0.7, longest_dead_streak=30, bonus_trigger_rate=0.006)
    assert tail.model_dump(by_alias=True, mode="json")["pGE100x"] == 0.001


def test_histogram_bin_hi_none_survives():
    b = HistogramBinWire(bin_lo=100.0, bin_hi=None, base=3, feature=1)
    assert b.model_dump(by_alias=True, mode="json")["binHi"] is None


def test_gen_snapshot_defaults():
    s = GenSnapshotWire(generation=1, best_fitness=0.5, best_rtp=0.9,
                        best_volatility=4.0)
    assert s.population.diversity == 0.0
    assert s.gene_agreement == []


def test_tuner_tool_names_stable():
    assert TUNER_TOOL_NAMES == {"read_tuner_setup", "set_tuner_params",
                                "tune_slot_model", "apply_tuned_model"}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd studio/backend && uv run pytest tests/test_math_models.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.math'`

- [ ] **Step 3: Write `app/math/models.py`**

Create empty `studio/backend/app/math/__init__.py`, then `studio/backend/app/math/models.py`. This is a **verbatim merge** of `app/simulator/models.py` + `app/tuner/models.py` + `app/analytics/models.py` with the additions marked `NEW`. Copy the class bodies exactly from the source files (they are the contract); the file skeleton:

```python
"""All math wire models: curation (was app/simulator/models.py), tuning (was
app/tuner/models.py), analytics runs (was app/analytics/models.py), plus the
unified SlotModelDoc (spec 2026-07-03-math-consolidation-design.md, sub-project 1)."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

TUNER_TOOL_NAMES: set[str] = {
    "read_tuner_setup", "set_tuner_params", "tune_slot_model", "apply_tuned_model",
}


class _WireModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


# ── curation (verbatim from app/simulator/models.py) ────────────────────────
# CurationParams, MetricsWire, CurationResult, default_params()  — copy exactly.

# ── tuning (verbatim from app/tuner/models.py) ──────────────────────────────
# TuneWeights, TuningParams, BandMissWire, PopulationStatsWire,
# _default_population_stats(), HistogramBinWire (keep the binHi/None comment),
# WinDistributionWire, TailWire (keep the explicit pGE100x alias), RtpPointWire,
# RunProfileWire, GenSnapshotWire, TuneResult, default_tuning_params() — copy
# exactly. Do NOT copy TunerJobDoc (superseded by the unified doc + tuner_view).


# ── NEW: section locks ───────────────────────────────────────────────────────
class SectionLocks(_WireModel):
    """Locks constrain automation (GA, apply-template), never humans.
    Stored from sub-project 1; enforced by the tuner in sub-project 2."""
    reels: bool = False
    paytable: bool = False
    bonus: bool = False


# ── NEW: the unified per-game math document (collection `slot_models`) ───────
class SlotModelDoc(_WireModel):
    id: str
    game_id: str
    model: dict
    params: CurationParams
    tuner_params: TuningParams = Field(default_factory=default_tuning_params)
    locks: SectionLocks = Field(default_factory=SectionLocks)
    presentation: dict = {}  # editor-side symbol labels/colors; opaque here
    result: CurationResult | None = None       # last curation of the STORED model
    tune_result: TuneResult | None = None      # last tune (tuned_model pending Apply)
    created_at: str
    updated_at: str


# ── analytics run doc (from app/analytics/models.py, + NEW verify field) ─────
class MathRunDoc(_WireModel):
    id: str
    game_id: str
    params: TuningParams
    verdict: str | None = None
    metrics: MetricsWire | None = None
    trace: list[GenSnapshotWire] = Field(default_factory=list)
    profile: RunProfileWire | None = None
    verify: CurationResult | None = None  # NEW: independent curate pass on the winner
    created_at: str
    duration_ms: int | None = None


# ── wire helpers ─────────────────────────────────────────────────────────────
def sim_wire(doc: SlotModelDoc) -> dict:
    # tune_result is carried by the /tuner wire (tuner_view); keep the editor
    # wire slim — a TuneResult embeds the full GA trace + profile.
    return doc.model_dump(by_alias=True, mode="json", exclude={"tune_result"})


def tuner_view(doc: SlotModelDoc) -> dict:
    """The legacy /games/{id}/tuner wire shape (was TunerJobDoc), synthesized
    from the unified doc so the existing tuner plugin keeps working unchanged."""
    return {
        "id": doc.id,
        "gameId": doc.game_id,
        "params": doc.tuner_params.model_dump(by_alias=True, mode="json"),
        "result": (doc.tune_result.model_dump(by_alias=True, mode="json")
                   if doc.tune_result is not None else None),
        "createdAt": doc.created_at,
        "updatedAt": doc.updated_at,
    }


def math_run_wire(doc: MathRunDoc) -> dict:
    return doc.model_dump(by_alias=True, mode="json")
```

Where a comment says "copy exactly", paste the source classes from the old files unchanged (including their inline comments — the `binHi` null note and the `pGE100x` alias note are load-bearing).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd studio/backend && uv run pytest tests/test_math_models.py -v`
Expected: PASS (all cases)

- [ ] **Step 5: Full unit gate still green, then commit**

Run: `cd studio/backend && uv run pytest -m "not e2e"` → all pass (old modules untouched).

```bash
git add studio/backend/app/math studio/backend/tests/test_math_models.py
git commit -m "feat(math): unified wire models with SectionLocks + unified SlotModelDoc"
```

---

### Task 2: Starter templates — `app/math/templates.py`

**Files:**

- Create: `studio/backend/app/math/templates.py`
- Test: `studio/backend/tests/test_math_templates.py`

**Interfaces:**

- Consumes: `SectionLocks` from `app.math.models`.
- Produces: `TEMPLATES: dict[str, dict]`, `DEFAULT_TEMPLATE = "video-5x3"`, `list_templates() -> list[dict]` (name/label/description), `get_model(name) -> dict` (deep copy; `KeyError` on unknown), `default_model() -> dict`, `apply_template(current_model: dict, template_model: dict, locks: SectionLocks) -> dict`.

The model literals written here are **seeds**; Task 7 replaces the `video-5x3` and `high-vol-5x4` (and re-freezes `classic-3x3`) with tuner output. Tests assert structure (shape, symbol roles, validity), not payouts, so the freeze won't break them.

- [ ] **Step 1: Write the failing tests**

`studio/backend/tests/test_math_templates.py`:

```python
from app.math import templates
from app.math.models import SectionLocks


def _structurally_valid(model: dict) -> None:
    ids = {s["id"] for s in model["symbols"]}
    assert len(model["reels"]) >= 3
    for strip in model["reels"]:
        assert set(strip) <= ids, "reel strip references unknown symbol"
    assert model["rows"] >= 3
    assert len(model["paylines"]) >= 1
    for line in model["paylines"]:
        assert len(line) == len(model["reels"])
        assert all(0 <= r < model["rows"] for r in line)
    assert len(model["paytable"]["entries"]) >= 1
    for e in model["paytable"]["entries"]:
        assert e["symbol"] in ids
    for b in model.get("bonuses", []):
        assert b["FreeSpins"]["trigger"]["symbol"] in ids


def test_all_templates_are_complete_playable_models():
    names = {t["name"] for t in templates.list_templates()}
    assert names == {"classic-3x3", "video-5x3", "high-vol-5x4"}
    for name in names:
        _structurally_valid(templates.get_model(name))


def test_default_is_video_5x3():
    assert templates.DEFAULT_TEMPLATE == "video-5x3"
    m = templates.default_model()
    assert len(m["reels"]) == 5 and m["rows"] == 3
    assert len(m["bonuses"]) == 1


def test_high_vol_is_5x4():
    m = templates.get_model("high-vol-5x4")
    assert len(m["reels"]) == 5 and m["rows"] == 4


def test_get_model_returns_fresh_copies():
    a = templates.get_model("video-5x3")
    a["rows"] = 99
    assert templates.get_model("video-5x3")["rows"] == 3


def test_get_model_unknown_raises_key_error():
    import pytest
    with pytest.raises(KeyError):
        templates.get_model("nope")


def test_apply_template_unlocked_takes_template_wholesale():
    current = templates.get_model("classic-3x3")
    tpl = templates.get_model("video-5x3")
    merged = templates.apply_template(current, tpl, SectionLocks())
    assert merged == tpl


def test_apply_template_locked_sections_keep_current_values():
    current = templates.get_model("classic-3x3")
    tpl = templates.get_model("video-5x3")
    locks = SectionLocks(reels=True, paytable=True, bonus=True)
    merged = templates.apply_template(current, tpl, locks)
    assert merged["reels"] == current["reels"]
    assert merged["rows"] == current["rows"]          # rows travel with reels
    assert merged["paytable"] == current["paytable"]
    assert merged["bonuses"] == current["bonuses"]
    assert merged["symbols"] == tpl["symbols"]        # symbols are not lockable


def test_apply_template_empty_current_ignores_locks():
    tpl = templates.get_model("video-5x3")
    merged = templates.apply_template({}, tpl, SectionLocks(reels=True))
    assert merged == tpl
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd studio/backend && uv run pytest tests/test_math_templates.py -v`
Expected: FAIL — `ImportError: cannot import name 'templates'`

- [ ] **Step 3: Write `app/math/templates.py`**

```python
"""Named starter SlotModels. A fresh game is seeded with DEFAULT_TEMPLATE so a
game's model is never {}. The video-5x3 / high-vol-5x4 literals are frozen
tuner output (tools/freeze_template.py, Task 7) so each template lands near its
stated target out of the box."""
import copy

from app.math.models import SectionLocks

_CLASSIC_3X3: dict = {
    # Identical to the proven runtime demo model (was DEMO_SLOT_MODEL in
    # app/scene/reels_spin.py; also runtime/server/demo/model.json).
    "symbols": [
        {"id": 0, "role": "normal"},
        {"id": 1, "role": "normal"},
        {"id": 2, "role": "normal"},
        {"id": 9, "role": "scatter"},
    ],
    "reels": [
        [0, 1, 2, 0, 1, 2, 9, 0, 1, 2],
        [0, 1, 2, 0, 1, 2, 9, 0, 1, 2],
        [0, 1, 2, 0, 1, 2, 9, 0, 1, 2],
    ],
    "rows": 3,
    "paylines": [[0, 0, 0], [1, 1, 1], [2, 2, 2]],
    "paytable": {"entries": [
        {"symbol": 0, "count": 3, "payout": 5},
        {"symbol": 1, "count": 3, "payout": 3},
        {"symbol": 2, "count": 3, "payout": 2},
    ]},
    "bonuses": [],
}

_VIDEO_5X3: dict = {
    # Seed version — replaced by frozen tuner output in Task 7 (target: RTP 96%
    # ±1%, medium volatility 3–6, bonus hit rate ~1:150 ±25%).
    "symbols": [
        {"id": 0, "role": "normal"},
        {"id": 1, "role": "normal"},
        {"id": 2, "role": "normal"},
        {"id": 3, "role": "normal"},
        {"id": 4, "role": "normal"},
        {"id": 5, "role": "normal"},
        {"id": 9, "role": "scatter"},
    ],
    "reels": [
        [0, 1, 2, 3, 0, 4, 1, 5, 0, 2, 9, 1, 3, 0, 2, 4, 1, 0, 5, 2, 3, 9, 0, 1, 2, 4, 0, 3, 1, 5],
        [1, 0, 3, 2, 1, 5, 0, 4, 1, 3, 9, 0, 2, 1, 3, 5, 0, 1, 4, 3, 2, 9, 1, 0, 3, 5, 1, 2, 0, 4],
        [2, 3, 0, 1, 2, 4, 3, 5, 2, 0, 9, 3, 1, 2, 0, 4, 3, 2, 5, 0, 1, 9, 2, 3, 0, 4, 2, 1, 3, 5],
        [3, 2, 1, 0, 3, 5, 2, 4, 3, 1, 9, 2, 0, 3, 1, 5, 2, 3, 4, 1, 0, 9, 3, 2, 1, 5, 3, 0, 2, 4],
        [0, 3, 2, 1, 0, 4, 3, 5, 0, 2, 9, 3, 1, 0, 2, 4, 3, 0, 5, 2, 1, 9, 0, 3, 2, 4, 0, 1, 3, 5],
    ],
    "rows": 3,
    "paylines": [
        [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2],
        [0, 1, 2, 1, 0], [2, 1, 0, 1, 2], [1, 0, 0, 0, 1],
        [1, 2, 2, 2, 1], [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [1, 2, 1, 0, 1],
    ],
    "paytable": {"entries": [
        {"symbol": 0, "count": 3, "payout": 2},  {"symbol": 0, "count": 4, "payout": 5},   {"symbol": 0, "count": 5, "payout": 15},
        {"symbol": 1, "count": 3, "payout": 3},  {"symbol": 1, "count": 4, "payout": 8},   {"symbol": 1, "count": 5, "payout": 20},
        {"symbol": 2, "count": 3, "payout": 4},  {"symbol": 2, "count": 4, "payout": 10},  {"symbol": 2, "count": 5, "payout": 30},
        {"symbol": 3, "count": 3, "payout": 5},  {"symbol": 3, "count": 4, "payout": 15},  {"symbol": 3, "count": 5, "payout": 50},
        {"symbol": 4, "count": 3, "payout": 10}, {"symbol": 4, "count": 4, "payout": 30},  {"symbol": 4, "count": 5, "payout": 100},
        {"symbol": 5, "count": 3, "payout": 15}, {"symbol": 5, "count": 4, "payout": 50},  {"symbol": 5, "count": 5, "payout": 200},
    ]},
    "bonuses": [{
        "FreeSpins": {
            "trigger": {"symbol": 9, "min_count": 3},
            "config": {"spins_awarded": 10, "retrigger": False,
                       "multiplier": 2, "feature_reels": None},
        },
    }],
}

_HIGH_VOL_5X4: dict = {
    # Seed version — replaced by frozen tuner output in Task 7 (target: RTP 96%
    # ±1%, high volatility 10+, bonus hit rate ~1:200 ±25%).
    "symbols": [
        {"id": 0, "role": "normal"},
        {"id": 1, "role": "normal"},
        {"id": 2, "role": "normal"},
        {"id": 3, "role": "normal"},
        {"id": 4, "role": "normal"},
        {"id": 9, "role": "scatter"},
    ],
    "reels": [
        [0, 1, 2, 0, 3, 1, 0, 4, 2, 1, 9, 0, 3, 1, 2, 0, 1, 4, 0, 2, 3, 1, 9, 0, 1, 2, 0, 3, 1, 4, 0, 2],
        [1, 0, 3, 1, 2, 0, 1, 4, 0, 2, 9, 1, 0, 3, 1, 2, 0, 1, 4, 3, 0, 2, 9, 1, 0, 2, 1, 3, 0, 4, 1, 2],
        [2, 1, 0, 2, 3, 1, 2, 4, 1, 0, 9, 2, 1, 3, 2, 0, 1, 2, 4, 0, 3, 1, 9, 2, 0, 1, 2, 3, 1, 4, 2, 0],
        [0, 2, 1, 0, 3, 2, 0, 4, 1, 2, 9, 0, 2, 3, 0, 1, 2, 0, 4, 1, 3, 2, 9, 0, 1, 2, 0, 3, 2, 4, 0, 1],
        [1, 2, 0, 1, 3, 0, 1, 4, 2, 0, 9, 1, 2, 3, 1, 0, 2, 1, 4, 0, 3, 2, 9, 1, 0, 2, 1, 3, 0, 4, 1, 2],
    ],
    "rows": 4,
    "paylines": [
        [0, 0, 0, 0, 0], [1, 1, 1, 1, 1], [2, 2, 2, 2, 2], [3, 3, 3, 3, 3],
        [0, 1, 2, 1, 0], [3, 2, 1, 2, 3], [1, 0, 0, 0, 1], [2, 3, 3, 3, 2],
        [0, 1, 1, 1, 0], [3, 2, 2, 2, 3],
    ],
    "paytable": {"entries": [
        {"symbol": 0, "count": 3, "payout": 1},  {"symbol": 0, "count": 4, "payout": 4},   {"symbol": 0, "count": 5, "payout": 12},
        {"symbol": 1, "count": 3, "payout": 2},  {"symbol": 1, "count": 4, "payout": 6},   {"symbol": 1, "count": 5, "payout": 25},
        {"symbol": 2, "count": 3, "payout": 4},  {"symbol": 2, "count": 4, "payout": 15},  {"symbol": 2, "count": 5, "payout": 60},
        {"symbol": 3, "count": 3, "payout": 10}, {"symbol": 3, "count": 4, "payout": 50},  {"symbol": 3, "count": 5, "payout": 250},
        {"symbol": 4, "count": 3, "payout": 25}, {"symbol": 4, "count": 4, "payout": 150}, {"symbol": 4, "count": 5, "payout": 1000},
    ]},
    "bonuses": [{
        "FreeSpins": {
            "trigger": {"symbol": 9, "min_count": 3},
            "config": {"spins_awarded": 12, "retrigger": False,
                       "multiplier": 3, "feature_reels": None},
        },
    }],
}

TEMPLATES: dict[str, dict] = {
    "classic-3x3": {
        "name": "classic-3x3", "label": "Classic 3×3",
        "description": "3 reels × 3 rows, low volatility, no bonus — a simple classic slot.",
        "model": _CLASSIC_3X3,
    },
    "video-5x3": {
        "name": "video-5x3", "label": "Video 5×3",
        "description": "5 reels × 3 rows, ~96% RTP, medium volatility, free-spins bonus. The default.",
        "model": _VIDEO_5X3,
    },
    "high-vol-5x4": {
        "name": "high-vol-5x4", "label": "High-Vol 5×4",
        "description": "5 reels × 4 rows, high volatility, steep top-end paytable, free-spins bonus.",
        "model": _HIGH_VOL_5X4,
    },
}

DEFAULT_TEMPLATE = "video-5x3"


def list_templates() -> list[dict]:
    return [{"name": t["name"], "label": t["label"], "description": t["description"]}
            for t in TEMPLATES.values()]


def get_model(name: str) -> dict:
    return copy.deepcopy(TEMPLATES[name]["model"])


def default_model() -> dict:
    return get_model(DEFAULT_TEMPLATE)


# Which model keys each lockable section owns. rows travels with reels — a
# locked reel-set keeps its own window height.
_LOCK_SECTIONS: dict[str, tuple[str, ...]] = {
    "reels": ("reels", "rows"),
    "paytable": ("paytable",),
    "bonus": ("bonuses",),
}


def apply_template(current_model: dict, template_model: dict,
                   locks: SectionLocks) -> dict:
    """Template wins, except sections the user locked keep their current values.
    Locks constrain automation, not humans (spec decision 4)."""
    merged = copy.deepcopy(template_model)
    current = current_model or {}
    for section, keys in _LOCK_SECTIONS.items():
        if getattr(locks, section):
            for key in keys:
                if key in current:
                    merged[key] = copy.deepcopy(current[key])
    return merged
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd studio/backend && uv run pytest tests/test_math_templates.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/math/templates.py studio/backend/tests/test_math_templates.py
git commit -m "feat(math): starter templates (classic-3x3 / video-5x3 / high-vol-5x4) + lock-aware apply"
```

---

### Task 3: The SoT store — `app/math/store.py` (MathStore + MathRunStore + migration + template seeding)

**Files:**

- Create: `studio/backend/app/math/store.py`
- Test: `studio/backend/tests/test_math_store.py`

**Interfaces:**

- Consumes: `app.math.models` (Task 1), `app.math.templates` (Task 2).
- Produces:
  - `MathStore(db, on_change=None)` — `get(game_id) -> SlotModelDoc|None` (lazy-migrates legacy docs), `get_or_seed(game_id) -> SlotModelDoc` (seeds `templates.default_model()`), `put(game_id, *, model=None, params=None, tuner_params=None, locks=None, presentation=None, source="api") -> SlotModelDoc` (fires `on_change(doc, source)` when model/presentation/locks change), `save_result(game_id, result: CurationResult)`, `save_tune_result(game_id, result: TuneResult)`.
  - `MathRunStore(db)` — moved verbatim from `app/analytics/store.py` (`append`, `list_for_game`, `get`), same `math_runs` collection.

- [ ] **Step 1: Write the failing tests**

`studio/backend/tests/test_math_store.py` — mirror the async/mongo pattern of the existing `tests/test_sim_store.py` (`mongo_db` fixture from conftest, `@pytest.mark.asyncio`):

```python
import pytest

from app.math import templates
from app.math.models import (
    CurationResult, MetricsWire, SectionLocks, TuneResult,
    default_params, default_tuning_params,
)
from app.math.store import MathStore, MathRunStore


def _metrics() -> MetricsWire:
    return MetricsWire(rtp=0.96, volatility=4.0, hit_frequency=0.3,
                       base_rtp=0.8, feature_rtp=0.16, bonus_hit_rates=[])


@pytest.mark.asyncio
async def test_get_or_seed_seeds_the_default_template(mongo_db):
    store = MathStore(mongo_db)
    doc = await store.get_or_seed("g-seed")
    assert doc.model == templates.default_model()   # never {} again
    assert doc.params == default_params()
    assert doc.tuner_params == default_tuning_params()
    assert doc.locks == SectionLocks()
    # And it persisted, not just returned:
    again = await store.get("g-seed")
    assert again.model == templates.default_model()


@pytest.mark.asyncio
async def test_put_updates_and_fires_on_change_for_model_presentation_locks(mongo_db):
    events: list[tuple[str, str]] = []

    async def on_change(doc, source):
        events.append((doc.game_id, source))

    store = MathStore(mongo_db, on_change=on_change)
    await store.put("g-put", model={"rows": 4}, source="editor")
    await store.put("g-put", presentation={"symbols": {}}, source="editor")
    await store.put("g-put", locks=SectionLocks(reels=True), source="editor")
    await store.put("g-put", tuner_params=default_tuning_params())  # no broadcast
    await store.put("g-put", params=default_params())               # no broadcast
    assert events == [("g-put", "editor")] * 3
    doc = await store.get("g-put")
    assert doc.model == {"rows": 4}
    assert doc.locks.reels is True


@pytest.mark.asyncio
async def test_save_tune_result_persists_without_broadcast(mongo_db):
    events = []

    async def on_change(doc, source):
        events.append(source)

    store = MathStore(mongo_db, on_change=on_change)
    await store.get_or_seed("g-tune")
    tr = TuneResult(status="pass", verdict="pass", tuned_model={"rows": 3},
                    metrics=_metrics(), ran_at="t1")
    await store.save_tune_result("g-tune", tr)
    doc = await store.get("g-tune")
    assert doc.tune_result.tuned_model == {"rows": 3}
    assert events == []


@pytest.mark.asyncio
async def test_save_result_persists_curation(mongo_db):
    store = MathStore(mongo_db)
    await store.get_or_seed("g-cur")
    await store.save_result("g-cur", CurationResult(status="pass",
                                                    metrics=_metrics(), ran_at="t1"))
    doc = await store.get("g-cur")
    assert doc.result.status == "pass"


@pytest.mark.asyncio
async def test_legacy_doc_migrates_tuner_fields_from_tuner_jobs(mongo_db):
    # A pre-merge slot_models doc (no tuner_params/locks/tune_result keys) whose
    # game has a customized legacy tuner_jobs doc.
    await mongo_db["slot_models"].insert_one({
        "_id": "legacy1", "game_id": "g-legacy", "model": {"rows": 3},
        "params": default_params().model_dump(mode="json"),
        "presentation": {}, "result": None,
        "created_at": "t0", "updated_at": "t0",
    })
    legacy_params = default_tuning_params().model_dump(mode="json")
    legacy_params["population"] = 48   # the customization that must survive
    tr = TuneResult(status="pass", verdict="pass", tuned_model={"rows": 5},
                    metrics=_metrics(), ran_at="t1")
    await mongo_db["tuner_jobs"].insert_one({
        "_id": "tj1", "game_id": "g-legacy", "params": legacy_params,
        "result": tr.model_dump(mode="json"),
        "created_at": "t0", "updated_at": "t0",
    })

    store = MathStore(mongo_db)
    doc = await store.get("g-legacy")
    assert doc.tuner_params.population == 48
    assert doc.tune_result.tuned_model == {"rows": 5}
    assert doc.locks == SectionLocks()
    # Migration is one-shot: the fields are now persisted on the doc itself.
    raw = await mongo_db["slot_models"].find_one({"game_id": "g-legacy"})
    assert raw["tuner_params"]["population"] == 48


@pytest.mark.asyncio
async def test_legacy_doc_without_tuner_jobs_gets_defaults(mongo_db):
    await mongo_db["slot_models"].insert_one({
        "_id": "legacy2", "game_id": "g-legacy2", "model": {},
        "params": default_params().model_dump(mode="json"),
        "presentation": {}, "result": None,
        "created_at": "t0", "updated_at": "t0",
    })
    store = MathStore(mongo_db)
    doc = await store.get("g-legacy2")
    assert doc.tuner_params == default_tuning_params()
    assert doc.tune_result is None


@pytest.mark.asyncio
async def test_math_run_store_appends_and_lists_newest_first(mongo_db):
    from app.math.models import MathRunDoc
    store = MathRunStore(mongo_db)
    for i in range(3):
        await store.append(MathRunDoc(id=f"r{i}", game_id="g-runs",
                                      params=default_tuning_params(),
                                      created_at=f"2026-07-03T0{i}:00:00+00:00"))
    runs = await store.list_for_game("g-runs")
    assert [r.id for r in runs] == ["r2", "r1", "r0"]
    assert (await store.get("r1")).id == "r1"
    assert await store.get("missing") is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd studio/backend && uv run pytest tests/test_math_store.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.math.store'`

- [ ] **Step 3: Write `app/math/store.py`**

```python
"""The one source-of-truth accessor for a game's math config. Was
app/simulator/store.py (SlotModelStore) + app/tuner/store.py (folded in as
tuner_params/tune_result on the same doc) + app/analytics/store.py (MathRunStore).
Collection names are unchanged: slot_models, math_runs. tuner_jobs survives
read-only as the lazy-migration source."""
import uuid
from datetime import datetime, timezone

from app.math import templates
from app.math.models import (
    CurationParams, CurationResult, MathRunDoc, SectionLocks, SlotModelDoc,
    TuneResult, TuningParams, default_params, default_tuning_params,
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _to_doc(doc: SlotModelDoc) -> dict:
    raw = doc.model_dump(mode="json")
    raw["_id"] = raw.pop("id")
    return raw


def _from_doc(raw: dict) -> SlotModelDoc:
    data = dict(raw)
    data["id"] = data.pop("_id")
    return SlotModelDoc.model_validate(data)


class MathStore:
    def __init__(self, db, on_change=None):
        # on_change: async (doc: SlotModelDoc, source: str) -> None; fired after
        # any model/presentation/locks write. Wired to a socket emit in main.py —
        # the store itself stays socket-free.
        self._docs = db["slot_models"]
        self._legacy_tuner_jobs = db["tuner_jobs"]  # migration source only
        self._on_change = on_change

    async def get(self, game_id: str) -> SlotModelDoc | None:
        raw = await self._docs.find_one({"game_id": game_id})
        if raw is None:
            return None
        if "tuner_params" not in raw:
            raw = await self._migrate_legacy_tuner(raw)
        return _from_doc(raw)

    async def _migrate_legacy_tuner(self, raw: dict) -> dict:
        """One-shot per-doc: fold the legacy tuner_jobs params/result into the
        unified doc and stamp default locks. Idempotent — after the $set the
        'tuner_params' key exists and this never runs again for the doc."""
        legacy = await self._legacy_tuner_jobs.find_one(
            {"game_id": raw["game_id"]}) or {}
        fields = {
            "tuner_params": legacy.get("params")
                or default_tuning_params().model_dump(mode="json"),
            "tune_result": legacy.get("result"),
            "locks": SectionLocks().model_dump(mode="json"),
        }
        await self._docs.update_one({"_id": raw["_id"]}, {"$set": fields})
        return {**raw, **fields}

    async def get_or_seed(self, game_id: str) -> SlotModelDoc:
        existing = await self.get(game_id)
        if existing is not None:
            return existing
        now = _now()
        doc = SlotModelDoc(
            id=str(uuid.uuid4()), game_id=game_id,
            model=templates.default_model(),   # never {}: spec decision 5
            params=default_params(),
            tuner_params=default_tuning_params(),
            locks=SectionLocks(),
            result=None, tune_result=None,
            created_at=now, updated_at=now,
        )
        await self._docs.insert_one(_to_doc(doc))
        return doc

    async def put(self, game_id: str, *, model: dict | None = None,
                  params: CurationParams | None = None,
                  tuner_params: TuningParams | None = None,
                  locks: SectionLocks | None = None,
                  presentation: dict | None = None,
                  source: str = "api") -> SlotModelDoc:
        await self.get_or_seed(game_id)
        fields: dict = {"updated_at": _now()}
        if model is not None:
            fields["model"] = model
        if params is not None:
            fields["params"] = params.model_dump(mode="json")
        if tuner_params is not None:
            fields["tuner_params"] = tuner_params.model_dump(mode="json")
        if locks is not None:
            fields["locks"] = locks.model_dump(mode="json")
        if presentation is not None:
            fields["presentation"] = presentation
        await self._docs.update_one({"game_id": game_id}, {"$set": fields})
        doc = await self.get(game_id)
        changed = model is not None or presentation is not None or locks is not None
        if self._on_change is not None and changed:
            await self._on_change(doc, source)
        return doc

    async def save_result(self, game_id: str, result: CurationResult) -> SlotModelDoc:
        await self.get_or_seed(game_id)
        await self._docs.update_one(
            {"game_id": game_id},
            {"$set": {"result": result.model_dump(mode="json"), "updated_at": _now()}},
        )
        return await self.get(game_id)

    async def save_tune_result(self, game_id: str, result: TuneResult) -> SlotModelDoc:
        await self.get_or_seed(game_id)
        await self._docs.update_one(
            {"game_id": game_id},
            {"$set": {"tune_result": result.model_dump(mode="json"),
                      "updated_at": _now()}},
        )
        return await self.get(game_id)


def _run_to_doc(doc: MathRunDoc) -> dict:
    raw = doc.model_dump(mode="json")
    raw["_id"] = raw.pop("id")
    return raw


def _run_from_doc(raw: dict) -> MathRunDoc:
    data = dict(raw)
    data["id"] = data.pop("_id")
    return MathRunDoc.model_validate(data)


class MathRunStore:
    """Append-only store over `math_runs` (verbatim from app/analytics/store.py)."""

    def __init__(self, db):
        self._docs = db["math_runs"]
        self._indexed = False

    async def _ensure_index(self) -> None:
        if self._indexed:
            return
        await self._docs.create_index([("game_id", 1), ("created_at", -1)])
        self._indexed = True

    async def append(self, run: MathRunDoc) -> MathRunDoc:
        await self._ensure_index()
        await self._docs.insert_one(_run_to_doc(run))
        return run

    async def list_for_game(self, game_id: str, limit: int = 50) -> list[MathRunDoc]:
        await self._ensure_index()
        cursor = (self._docs.find({"game_id": game_id})
                  .sort("created_at", -1).limit(limit))
        return [_run_from_doc(raw) async for raw in cursor]

    async def get(self, run_id: str) -> MathRunDoc | None:
        raw = await self._docs.find_one({"_id": run_id})
        return _run_from_doc(raw) if raw else None
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd studio/backend && uv run pytest tests/test_math_store.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/math/store.py studio/backend/tests/test_math_store.py
git commit -m "feat(math): MathStore with unified doc, lazy tuner_jobs migration, template seeding"
```

---

### Task 4: Engine move + MathHub + merged REST/sockets (old modules untouched)

**Files:**

- Create (copy + adapt): `studio/backend/app/math/targets.py`, `app/math/bounds.py`, `app/math/realize.py`, `app/math/runners/__init__.py` (empty), `app/math/runners/curate.py`, `app/math/runners/tune.py`
- Create: `studio/backend/app/math/hub.py`, `app/math/rest.py`, `app/math/sockets.py`
- Test: `studio/backend/tests/test_math_hub.py`, `tests/test_math_rest.py`, `tests/test_math_sockets.py`

**Interfaces:**

- Consumes: Tasks 1–3 (`app.math.models`, `templates`, `store`).
- Produces:
  - `app.math.targets`: `derive_target`, `TargetGap`, `VOLATILITY_BANDS`, `normalize_percent`, `parse_ratio` (verbatim move).
  - `app.math.bounds`: `build_config`, `derive_bounds` (verbatim move).
  - `app.math.realize`: `realize_slot_model` etc. (verbatim move).
  - `app.math.runners.curate`: `SubprocessCurationRunner`, `FakeCurationRunner`, `CurationProgress`, `build_curation_runner` (verbatim move of `app/simulator/runner.py`).
  - `app.math.runners.tune`: `SubprocessTunerRunner`, `FakeTunerRunner`, `TuneProgress`, `parse_tune_result_line`, `build_tuner_runner` (verbatim move of `app/tuner/runner.py`).
  - `app.math.hub.MathHub(sio, store, run_store, curation_runner, tuner_runner, gdd_store)` — `attach_sim_subscriber`, `attach_tuner_subscriber`, `attach_analytics_subscriber`, `request_curation(game_id)`, `request_tune(game_id, *, record=True) -> TuneResult | None`, `record_run(game_id, params, result, duration_ms, verify=None)`.
  - `app.math.rest.router` — every existing sim/tuner/analytics route plus `GET /slot-model/templates` and `POST /games/{game_id}/slot-model/apply-template`, all reading `request.app.state.math_store` / `math_hub` / `math_run_store`.
  - `app.math.sockets.register_math_handlers(sio, hub)` — the six existing event names.

- [ ] **Step 1: Copy the engine files (no behavior change)**

```bash
cd studio/backend
cp app/simulator/targets.py app/math/targets.py
cp app/tuner/bounds.py      app/math/bounds.py
cp app/simulator/realize.py app/math/realize.py
mkdir -p app/math/runners && type nul > app/math/runners/__init__.py
cp app/simulator/runner.py  app/math/runners/curate.py
cp app/tuner/runner.py      app/math/runners/tune.py
```

Then inside each copied file:

- Replace every `from app.simulator.models import ...` / `from app.tuner.models import ...` with `from app.math.models import ...`.
- In `bounds.py`: `from app.tuner.models import TuningParams` → `from app.math.models import TuningParams`.
- In `runners/curate.py` and `runners/tune.py`: the files now sit one directory deeper, so change `_REPO_ROOT = Path(__file__).resolve().parents[4]` to `parents[5]` (both files). Update the comment above it accordingly.
- `app/math/realize.py`: update any intra-package imports the same way (check its header; it may import from `app.simulator.models`).

- [ ] **Step 2: Write `app/math/hub.py`**

A single hub replacing `CurationHub` + `TunerHub` + `AnalyticsHub`. The bodies of `request_curation` and `request_tune` are the old hub bodies with the store calls retargeted at the unified doc; copy the concurrency/`sync_progress` scaffolding exactly as it appears in the old hubs:

```python
"""MathHub — curation, tuning, and analytics recording over the unified doc.
Merges app/simulator/hub.py (CurationHub), app/tuner/hub.py (TunerHub) and
app/analytics/hub.py (AnalyticsHub). Event names are unchanged:
curation_progress/complete/failed, tuning_progress/complete/failed,
analytics_progress, run_complete."""
import asyncio
import time
import uuid
from datetime import datetime, timezone

from app.math.bounds import build_config, derive_bounds
from app.math.models import (
    CurationResult, MathRunDoc, TuneResult, TuningParams,
    math_run_wire, sim_wire, tuner_view,
)
from app.math.targets import derive_target, TargetGap


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class MathHub:
    def __init__(self, sio, store, run_store, curation_runner, tuner_runner, gdd_store):
        self._sio = sio
        self._store = store
        self._runs = run_store
        self._curation_runner = curation_runner
        self._tuner_runner = tuner_runner
        self._gdd = gdd_store
        self._active: set[str] = set()  # games with a generate pipeline in flight

    # ── subscriptions (one per legacy pane; event names preserved) ──────────
    async def attach_sim_subscriber(self, game_id: str, sid: str) -> None:
        await self._sio.enter_room(sid, game_id)
        doc = await self._store.get(game_id)
        if doc is not None and doc.result is not None:
            await self._sio.emit("curation_complete",
                                 {"gameId": game_id, "doc": sim_wire(doc)}, to=sid)

    async def attach_tuner_subscriber(self, game_id: str, sid: str) -> None:
        await self._sio.enter_room(sid, game_id)
        doc = await self._store.get(game_id)
        if doc is not None and doc.tune_result is not None:
            await self._sio.emit("tuning_complete",
                                 {"gameId": game_id, "doc": tuner_view(doc)}, to=sid)

    async def attach_analytics_subscriber(self, game_id: str, sid: str) -> None:
        await self._sio.enter_room(sid, game_id)
        latest = await self._runs.list_for_game(game_id, limit=1)
        if latest:
            await self._sio.emit("run_complete",
                                 {"gameId": game_id, "run": math_run_wire(latest[0])},
                                 to=sid)

    # ── target derivation (shared) ───────────────────────────────────────────
    async def _derive_target(self, game_id: str, doc) -> dict:
        model = doc.model or {}
        num_bonuses = len(model.get("bonuses", []) or [])
        gdd = await self._gdd.get_doc(game_id, "math-model")
        math_model = getattr(gdd, "data", {}) if gdd is not None else {}
        return derive_target(math_model, doc.params, num_bonuses)

    # ── curation (was CurationHub.request_curation) ─────────────────────────
    async def request_curation(self, game_id: str) -> None:
        doc = await self._store.get_or_seed(game_id)
        try:
            target = await self._derive_target(game_id, doc)
        except TargetGap as gap:
            await self._sio.emit("curation_failed",
                                 {"gameId": game_id, "failure": gap.message},
                                 room=game_id)
            return

        async def on_progress(p):
            await self._sio.emit(
                "curation_progress",
                {"gameId": game_id, "phase": p.phase, "done": p.done, "total": p.total},
                room=game_id)

        pending: list[asyncio.Task] = []
        loop = asyncio.get_running_loop()

        def sync_progress(p):
            pending.append(loop.create_task(on_progress(p)))

        result = await self._curation_runner.run(doc.model or {}, target,
                                                 on_progress=sync_progress)
        if pending:
            await asyncio.gather(*pending)
        saved = await self._store.save_result(game_id, result)
        event = "curation_complete" if result.status in ("pass", "fail") else "curation_failed"
        await self._sio.emit(event, {"gameId": game_id, "doc": sim_wire(saved)},
                             room=game_id)

    # ── tuning (was TunerHub.request_tune) ──────────────────────────────────
    async def request_tune(self, game_id: str, *, record: bool = True) -> TuneResult | None:
        """Run one GA tune. Returns the TuneResult (None on target gap). With
        record=False the math_runs append is skipped — the generate pipeline
        (Task 6) records the run itself so it can attach the verify verdict."""
        doc = await self._store.get_or_seed(game_id)
        model = doc.model or {}
        try:
            target = await self._derive_target(game_id, doc)
        except TargetGap as gap:
            await self._sio.emit("tuning_failed",
                                 {"gameId": game_id, "failure": gap.message},
                                 room=game_id)
            return None

        config = build_config(doc.tuner_params, derive_bounds(model))

        async def on_progress(p):
            await self._sio.emit(
                "tuning_progress",
                {"gameId": game_id, "generation": p.generation,
                 "maxGenerations": p.max_generations, "bestFitness": p.best_fitness,
                 "bestRtp": p.best_rtp, "bestVolatility": p.best_volatility},
                room=game_id)
            # Ephemeral enriched frame for the (live) analytics Evolution tab.
            await self._sio.emit(
                "analytics_progress",
                {"gameId": game_id, "generation": p.generation,
                 "maxGenerations": p.max_generations,
                 "best": {"fitness": p.best_fitness, "rtp": p.best_rtp,
                          "volatility": p.best_volatility},
                 "population": p.population.model_dump(by_alias=True, mode="json"),
                 "geneAgreement": p.gene_agreement},
                room=game_id)

        pending: list[asyncio.Task] = []
        loop = asyncio.get_running_loop()

        def sync_progress(p):
            pending.append(loop.create_task(on_progress(p)))

        started = time.monotonic()
        result = await self._tuner_runner.run(model, target, config,
                                              on_progress=sync_progress)
        duration_ms = int((time.monotonic() - started) * 1000)
        if pending:
            await asyncio.gather(*pending)
        saved = await self._store.save_tune_result(game_id, result)

        event = "tuning_complete" if result.status in ("pass", "near_miss") else "tuning_failed"
        await self._sio.emit(event, {"gameId": game_id, "doc": tuner_view(saved)},
                             room=game_id)
        if record and result.status in ("pass", "near_miss"):
            await self.record_run(game_id, doc.tuner_params, result, duration_ms)
        return result

    # ── run recording (was AnalyticsHub.record_run, + verify) ───────────────
    async def record_run(self, game_id: str, params: TuningParams,
                         result: TuneResult, duration_ms: int,
                         verify: CurationResult | None = None) -> MathRunDoc | None:
        if result.status not in ("pass", "near_miss"):
            return None
        doc = MathRunDoc(
            id=str(uuid.uuid4()), game_id=game_id, params=params,
            verdict=result.verdict, metrics=result.metrics, trace=result.trace,
            profile=result.profile, verify=verify,
            created_at=_now(), duration_ms=duration_ms,
        )
        saved = await self._runs.append(doc)
        await self._sio.emit("run_complete",
                             {"gameId": game_id, "run": math_run_wire(saved)},
                             room=game_id)
        return saved
```

- [ ] **Step 3: Write `app/math/sockets.py`**

```python
"""Socket subscriptions for the three legacy panes. Event names preserved."""


def register_math_handlers(sio, hub):
    @sio.on("join_sim")
    async def join_sim(sid, data):
        await hub.attach_sim_subscriber(data["gameId"], sid)

    @sio.on("leave_sim")
    async def leave_sim(sid, data):
        await sio.leave_room(sid, data["gameId"])

    @sio.on("join_tuner")
    async def join_tuner(sid, data):
        await hub.attach_tuner_subscriber(data["gameId"], sid)

    @sio.on("leave_tuner")
    async def leave_tuner(sid, data):
        await sio.leave_room(sid, data["gameId"])

    @sio.on("join_analytics")
    async def join_analytics(sid, data):
        await hub.attach_analytics_subscriber(data["gameId"], sid)

    @sio.on("leave_analytics")
    async def leave_analytics(sid, data):
        await sio.leave_room(sid, data["gameId"])
```

- [ ] **Step 4: Write `app/math/rest.py`**

Every route from `app/simulator/rest.py`, `app/tuner/rest.py`, `app/analytics/rest.py` — paths and response shapes unchanged, state renamed — plus the two template routes:

```python
import asyncio

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from app.math import templates
from app.math.models import CurationParams, TuningParams, sim_wire, tuner_view
from app.math.models import math_run_wire
from app.math.targets import derive_target, TargetGap

router = APIRouter()


class PutSlotModelBody(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    model: dict | None = None
    params: CurationParams | None = None
    presentation: dict | None = None
    source: str = "api"


class PutTunerBody(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    params: TuningParams | None = None


class ApplyTemplateBody(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    name: str


# ── slot-model (was app/simulator/rest.py) ──────────────────────────────────
@router.get("/games/{game_id}/slot-model")
async def get_slot_model(game_id: str, request: Request) -> dict:
    doc = await request.app.state.math_store.get_or_seed(game_id)
    return sim_wire(doc)


@router.put("/games/{game_id}/slot-model")
async def put_slot_model(game_id: str, body: PutSlotModelBody, request: Request) -> dict:
    doc = await request.app.state.math_store.put(
        game_id, model=body.model, params=body.params,
        presentation=body.presentation, source=body.source)
    return sim_wire(doc)


@router.post("/games/{game_id}/slot-model/curate", status_code=202)
async def curate_slot_model(game_id: str, request: Request) -> Response:
    asyncio.create_task(request.app.state.math_hub.request_curation(game_id))
    return Response(status_code=202)


@router.get("/games/{game_id}/slot-model/result")
async def get_slot_model_result(game_id: str, request: Request) -> dict | None:
    doc = await request.app.state.math_store.get(game_id)
    if doc is None or doc.result is None:
        return None
    return doc.result.model_dump(by_alias=True, mode="json")


# ── templates (NEW) ──────────────────────────────────────────────────────────
@router.get("/slot-model/templates")
async def list_slot_model_templates() -> list[dict]:
    return templates.list_templates()


@router.post("/games/{game_id}/slot-model/apply-template")
async def apply_slot_model_template(game_id: str, body: ApplyTemplateBody,
                                    request: Request) -> dict:
    try:
        template_model = templates.get_model(body.name)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"unknown template '{body.name}'")
    store = request.app.state.math_store
    doc = await store.get_or_seed(game_id)
    merged = templates.apply_template(doc.model or {}, template_model, doc.locks)
    updated = await store.put(game_id, model=merged, source="template")
    return sim_wire(updated)


# ── tuner (was app/tuner/rest.py; wire shapes preserved via tuner_view) ─────
@router.get("/games/{game_id}/tuner")
async def get_tuner(game_id: str, request: Request) -> dict:
    doc = await request.app.state.math_store.get_or_seed(game_id)
    return tuner_view(doc)


@router.put("/games/{game_id}/tuner")
async def put_tuner(game_id: str, body: PutTunerBody, request: Request) -> dict:
    doc = await request.app.state.math_store.put(game_id, tuner_params=body.params)
    return tuner_view(doc)


@router.get("/games/{game_id}/tuner/seed")
async def get_tuner_seed(game_id: str, request: Request) -> dict:
    doc = await request.app.state.math_store.get_or_seed(game_id)
    return {"model": doc.model}


@router.get("/games/{game_id}/tuner/target")
async def get_tuner_target(game_id: str, request: Request) -> dict:
    doc = await request.app.state.math_store.get_or_seed(game_id)
    model = doc.model or {}
    num_bonuses = len(model.get("bonuses", []) or [])
    gdd = await request.app.state.gdd_store.get_doc(game_id, "math-model")
    math_model = getattr(gdd, "data", {}) if gdd is not None else {}
    try:
        return {"target": derive_target(math_model, doc.params, num_bonuses)}
    except TargetGap as gap:
        return {"gap": gap.message}


@router.post("/games/{game_id}/tuner/tune", status_code=202)
async def tune_tuner(game_id: str, request: Request) -> Response:
    asyncio.create_task(request.app.state.math_hub.request_tune(game_id))
    return Response(status_code=202)


@router.post("/games/{game_id}/tuner/apply")
async def apply_tuner(game_id: str, request: Request) -> dict:
    doc = await request.app.state.math_store.get(game_id)
    tuned = doc.tune_result.tuned_model if (doc and doc.tune_result) else None
    if not tuned:
        raise HTTPException(status_code=400, detail="no tuned model to apply")
    updated = await request.app.state.math_store.put(game_id, model=tuned,
                                                     source="tuner")
    return sim_wire(updated)


@router.get("/games/{game_id}/tuner/result")
async def get_tuner_result(game_id: str, request: Request) -> dict | None:
    doc = await request.app.state.math_store.get(game_id)
    if doc is None or doc.tune_result is None:
        return None
    return doc.tune_result.model_dump(by_alias=True, mode="json")


# ── analytics (was app/analytics/rest.py) ───────────────────────────────────
@router.get("/analytics/runs")
async def list_runs(game_id: str, request: Request, limit: int = 50) -> list[dict]:
    docs = await request.app.state.math_run_store.list_for_game(game_id, limit=limit)
    return [math_run_wire(doc) for doc in docs]


@router.get("/analytics/runs/{run_id}")
async def get_run(run_id: str, request: Request) -> dict:
    doc = await request.app.state.math_run_store.get(run_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="run not found")
    return math_run_wire(doc)
```

- [ ] **Step 5: Port the hub/rest/sockets tests**

Create three new test files by porting the old ones (they are deleted in Task 5 — **before deleting, diff each old file against the new one and port any case not yet covered**):

1. `tests/test_math_hub.py` — port every case from `tests/test_sim_hub.py`, `tests/test_tuner_hub.py`, `tests/test_analytics_hub.py`, and `tests/test_analytics_live.py`, with these mechanical changes:
   - Construct one `MathHub(sio, store, run_store, curation_runner, tuner_runner, gdd_store)` instead of the three hubs (reuse the old files' `FakeSio` / fake gdd-store helpers verbatim).
   - `SlotModelStore` → `MathStore`; `TunerStore` params writes → `store.put(game_id, tuner_params=...)`; tuner result assertions read `doc.tune_result`.
   - `AnalyticsHub.record_run(...)` → `hub.record_run(...)`; `attach_subscriber` → the three `attach_*_subscriber` names.
   - Fakes import from `app.math.runners.curate` / `app.math.runners.tune`.
2. `tests/test_math_rest.py` — port every case from `tests/test_sim_rest.py`, `tests/test_tuner_rest.py`, `tests/test_analytics_rest.py` (keep their FastAPI/state harness pattern; rename state attrs `sim_store`/`sim_hub`/`tuner_store`/`tuner_hub` → `math_store`/`math_hub`, keep `math_run_store` and `gdd_store`), and **add** these new cases:

```python
@pytest.mark.asyncio
async def test_list_templates_route(...):
    # GET /slot-model/templates → 200, three entries with name/label/description,
    # no model payloads.

@pytest.mark.asyncio
async def test_apply_template_respects_locks(...):
    # Seed a game, put locks=SectionLocks(paytable=True) and a custom paytable,
    # POST apply-template {"name": "classic-3x3"} → response model has the
    # template's reels but the CURRENT paytable; slot_model_changed fired with
    # source "template" (assert via the store's on_change hook or sim_wire echo).

@pytest.mark.asyncio
async def test_apply_template_unknown_404(...):
    # POST apply-template {"name": "nope"} → 404.
```

3. `tests/test_math_sockets.py` — port `tests/test_sim_sockets.py` / `test_tuner_sockets.py` / `test_analytics_sockets.py` into one file registering `register_math_handlers` and asserting all six event names dispatch to the right attach/leave calls.

- [ ] **Step 6: Run the new tests + full unit gate**

Run: `cd studio/backend && uv run pytest tests/test_math_hub.py tests/test_math_rest.py tests/test_math_sockets.py -v` → PASS
Run: `uv run pytest -m "not e2e"` → all green (old modules still untouched and still wired).

- [ ] **Step 7: Commit**

```bash
git add studio/backend/app/math studio/backend/tests/test_math_hub.py studio/backend/tests/test_math_rest.py studio/backend/tests/test_math_sockets.py
git commit -m "feat(math): MathHub + merged REST/sockets + engine modules under app/math"
```

---

### Task 5: The flip — rewire the app, delete `app/simulator` + `app/tuner` + `app/analytics`

**Files:**

- Modify: `studio/backend/app/main.py`, `app/room_hub.py`, `app/agent_tools.py`, `app/scene/sockets.py`, `app/scene/reels_spin.py`
- Delete: `studio/backend/app/simulator/` (all), `app/tuner/` (all), `app/analytics/` (all)
- Delete (superseded by Tasks 1–4 tests): `tests/test_sim_models.py`, `test_sim_store.py`, `test_sim_hub.py`, `test_sim_rest.py`, `test_sim_sockets.py`, `test_sim_wiring.py`, `test_tuner_models.py`, `test_tuner_store.py`, `test_tuner_hub.py`, `test_tuner_rest.py`, `test_tuner_sockets.py`, `test_tuner_wiring.py`, `test_analytics_models.py`, `test_analytics_store.py`, `test_analytics_hub.py`, `test_analytics_rest.py`, `test_analytics_sockets.py`, `test_analytics_live.py`
- Modify (import mapping only): `tests/test_sim_targets.py`, `test_sim_runner.py`, `test_sim_curate_binary.py`, `test_tuner_bounds.py`, `test_tuner_runner.py`, `test_tuner_runner_parse.py`, `test_tuner_tune_binary.py`, `test_realize.py`, `tests/e2e/test_realize_parity.py`, `tests/test_skills.py`, `test_design_game_skill.py`, `test_design_scene_skill.py`, `test_replay_run_cassettes.py` (if it imports math modules)
- Modify (rework): `tests/test_tuner_tools.py`, `tests/test_agent_tools.py`, `tests/test_room_hub_wiring.py` (or wherever RoomHub/ToolFactory kwargs appear), `tests/test_reels_spin.py`, `tests/test_reels_sockets.py`
- Create: `tests/test_math_wiring.py`

**Interfaces:**

- Consumes: everything from Tasks 1–4.
- Produces: `app.state.math_store` / `math_hub` / `math_run_store` (replacing `sim_store`, `sim_hub`, `tuner_store`, `tuner_hub`, `analytics_hub`); `ToolFactory(..., math_store=, math_hub=)` and `ToolContext.math_store` / `.math_hub` (replacing `sim_store`/`tuner_store`/`tuner_hub`); `RoomHub(..., math_store=, math_hub=)`.

**Import mapping** (apply everywhere; after the sweep `grep -rn "app\.simulator\|app\.tuner\|app\.analytics" studio/backend --include="*.py"` must return zero):

| Old                                                                                 | New                                 |
| ----------------------------------------------------------------------------------- | ----------------------------------- |
| `app.simulator.models` / `app.tuner.models` / `app.analytics.models`                | `app.math.models`                   |
| `app.simulator.store` (`SlotModelStore`)                                            | `app.math.store` (`MathStore`)      |
| `app.analytics.store` (`MathRunStore`)                                              | `app.math.store` (`MathRunStore`)   |
| `app.tuner.store` (`TunerStore`)                                                    | — deleted (unified doc)             |
| `app.simulator.targets`                                                             | `app.math.targets`                  |
| `app.simulator.realize`                                                             | `app.math.realize`                  |
| `app.tuner.bounds`                                                                  | `app.math.bounds`                   |
| `app.simulator.runner`                                                              | `app.math.runners.curate`           |
| `app.tuner.runner`                                                                  | `app.math.runners.tune`             |
| `app.simulator.hub` / `app.tuner.hub` / `app.analytics.hub`                         | `app.math.hub` (`MathHub`)          |
| `app.simulator.rest` / `app.tuner.rest` / `app.analytics.rest`                      | `app.math.rest`                     |
| `register_sim_handlers` / `register_tuner_handlers` / `register_analytics_handlers` | `register_math_handlers` (one call) |

- [ ] **Step 1: Rewire `main.py`**

Replace the imports listed in the mapping and the wiring block. The math section of `build()` becomes:

```python
from app.math.hub import MathHub
from app.math.rest import router as math_router
from app.math.runners.curate import build_curation_runner
from app.math.runners.tune import build_tuner_runner
from app.math.sockets import register_math_handlers
from app.math.store import MathRunStore, MathStore
```

```python
    async def _on_slot_model_change(doc, source: str) -> None:
        # Single choke point: every model/presentation/locks write (editor PUT,
        # tuner apply, template apply, agent tools) reaches any open pane.
        await sio.emit(
            "slot_model_changed",
            {"gameId": doc.game_id, "updatedAt": doc.updated_at, "source": source},
            room=doc.game_id,
        )

    math_store = MathStore(mongo[settings.mongo_db], on_change=_on_slot_model_change)
    math_run_store = MathRunStore(mongo[settings.mongo_db])
    math_hub = MathHub(sio, math_store, math_run_store,
                       build_curation_runner(settings), build_tuner_runner(settings),
                       gdd_store)
```

- `ToolFactory(...)`: `sim_store=sim_store, tuner_store=tuner_store, tuner_hub=tuner_hub` → `math_store=math_store, math_hub=math_hub`.
- `RoomHub(...)`: `sim_store=sim_store, tuner_store=tuner_store, tuner_hub=tuner_hub` → `math_store=math_store, math_hub=math_hub`.
- State: replace the five old attrs with `fastapi_app.state.math_store = math_store`, `.math_hub = math_hub`, `.math_run_store = math_run_store`.
- Routers: replace `include_router(sim_router)` + `(tuner_router)` + `(analytics_router)` with one `fastapi_app.include_router(math_router)`.
- Handlers: replace `register_sim_handlers` + `register_tuner_handlers` + `register_analytics_handlers` with one `register_math_handlers(sio, math_hub)`.
- Scene: `register_scene_handlers(sio, scene_hub, capture_broker, math_store, spin_runner)` (same positional slot the `sim_store` occupied).

- [ ] **Step 2: Rewire `RoomHub` (`app/room_hub.py`)**

At the three sites found by `grep -n "sim_store\|tuner_store\|tuner_hub" app/room_hub.py` (constructor kwargs ~lines 30–32, attrs ~52–54, ToolContext pass-through ~301–302): replace the three params with `math_store=None, math_hub=None`, the three attrs with `self._math_store` / `self._math_hub`, and the pass-through with `math_store=self._math_store, math_hub=self._math_hub`.

- [ ] **Step 3: Rewire `agent_tools.py`**

Tool **names, descriptions, and return-text strings must not change** (cassette prompt-keys). Changes:

- Imports: `from app.simulator.targets import derive_target, TargetGap` → `from app.math.targets import ...`; `from app.tuner.models import TuningParams` → `from app.math.models import TuningParams`.
- `ToolContext` (~line 38): replace the three fields with `math_store: object = None` and `math_hub: object = None`.
- `ToolFactory.__init__` (~line 1514): same kwarg replacement; store `self._math_store` / `self._math_hub`. Update whatever method threads them into `ToolContext` (search `sim_store=` in this file).
- `build_read_tuner_setup_tool`: one doc now carries everything —

```python
        sim_doc = await ctx.math_store.get_or_seed(ctx.game_id)
        model = sim_doc.model or {}
        num_bonuses = len(model.get("bonuses", []) or [])
        paytable = (model.get("paytable") or {}).get("entries") or []
        p = sim_doc.tuner_params
```

and `result = tuner_doc.result` → `result = sim_doc.tune_result`. Delete the `tuner_doc` fetch. Everything else (target block, return f-string) byte-identical.

- `build_set_tuner_params_tool`: `doc = await ctx.tuner_store.get_or_seed(ctx.game_id)` → `doc = await ctx.math_store.get_or_seed(ctx.game_id)`; `data = doc.params.model_dump()` → `data = doc.tuner_params.model_dump()`; `await ctx.tuner_store.put(ctx.game_id, params=updated)` → `await ctx.math_store.put(ctx.game_id, tuner_params=updated)`. Return text unchanged.
- `build_tune_slot_model_tool`:

```python
        sim_doc = await ctx.math_store.get_or_seed(ctx.game_id)
        ...
        before_ran = sim_doc.tune_result.ran_at if sim_doc.tune_result else None

        await ctx.math_hub.request_tune(ctx.game_id)   # runs GA, streams to the pane

        after = await ctx.math_store.get(ctx.game_id)
        result = after.tune_result if after else None
```

(the target pre-check block and every return string stay byte-identical; Task 6 swaps `request_tune` for the generate pipeline).

- `build_apply_tuned_model_tool`: `doc = await ctx.tuner_store.get(...)` → `ctx.math_store.get(...)`; `doc.result.tuned_model` → `doc.tune_result.tuned_model`; `ctx.sim_store.put(...)` → `ctx.math_store.put(...)`. Interrupt label + return text unchanged.
- Any other `ctx.sim_store` uses in this file (search — e.g. GDD/realize tools reading the slot model): rename to `ctx.math_store` (same methods exist).

- [ ] **Step 4: Scene fallback deletion**

- `app/scene/reels_spin.py`: delete the `DEMO_SLOT_MODEL` block (lines ~14–36) and its comment. Nothing else in the file changes.
- `app/scene/sockets.py`: drop `DEMO_SLOT_MODEL` from the import; `_model_for` becomes:

```python
    async def _model_for(game_id: str) -> dict:
        # get_or_seed guarantees a complete template model — a game's model is
        # never {} (spec decision 5), so the old DEMO fallback is gone.
        doc = await model_store.get_or_seed(game_id)
        return doc.model
```

- [ ] **Step 5: Delete old packages + superseded tests, sweep imports**

```bash
cd studio/backend
git rm -r app/simulator app/tuner app/analytics
git rm tests/test_sim_models.py tests/test_sim_store.py tests/test_sim_hub.py \
       tests/test_sim_rest.py tests/test_sim_sockets.py tests/test_sim_wiring.py \
       tests/test_tuner_models.py tests/test_tuner_store.py tests/test_tuner_hub.py \
       tests/test_tuner_rest.py tests/test_tuner_sockets.py tests/test_tuner_wiring.py \
       tests/test_analytics_models.py tests/test_analytics_store.py \
       tests/test_analytics_hub.py tests/test_analytics_rest.py \
       tests/test_analytics_sockets.py tests/test_analytics_live.py
```

Then apply the import mapping to every remaining file:
`grep -rln "app\.simulator\|app\.tuner\|app\.analytics" studio/backend --include="*.py"` and fix each hit (class rename `SlotModelStore` → `MathStore` included). Rework the non-mechanical test files:

- `tests/test_tuner_tools.py`: build `MathStore` + `MathHub` (Task 4 constructor) instead of `SlotModelStore`+`TunerStore`+`TunerHub`; `ToolContext(math_store=..., math_hub=...)`. Tuner-param assertions read `(await store.get(gid)).tuner_params`; tune-result assertions read `.tune_result`. The tools' return-string assertions must pass **unchanged** — that is the cassette-compat proof.
- `tests/test_agent_tools.py` + RoomHub wiring tests: kwarg renames only.
- `tests/test_reels_spin.py`: `DEMO_SLOT_MODEL` is gone — assert against the template instead:

```python
from app.math import templates

def test_classic_template_shape():
    m = templates.get_model("classic-3x3")
    assert len(m["reels"]) == 3
    assert m["rows"] == 3
    assert {s["id"] for s in m["symbols"]} == {0, 1, 2, 9}
```

(keep the `derive_reels_config` / `map_grid` / `FakeSpinRunner` cases, fed with `templates.get_model("classic-3x3")`).

- `tests/test_reels_sockets.py`: `FakeModelStore` gains `get_or_seed` (the "no model → DEMO fallback" case becomes "empty store → seeded template"):

```python
class FakeModelStore:
    def __init__(self, model=None):
        self._model = model

    async def get_or_seed(self, game_id):
        from app.math import templates
        from types import SimpleNamespace
        return SimpleNamespace(model=self._model or templates.default_model())
```

and the old fallback test now asserts the spin config derives from `templates.default_model()` (5 reels × 3 rows).

- [ ] **Step 6: New wiring test**

`tests/test_math_wiring.py`:

```python
from app.config import Settings
from app.main import build


def test_math_wiring_exposes_unified_state_and_routes():
    ctx = build(Settings(provider_mode="replay", mongo_db="bloom_studio_test"))
    app = ctx.fastapi_app
    assert app.state.math_store is not None
    assert app.state.math_hub is not None
    assert app.state.math_run_store is not None
    for legacy in ("sim_store", "sim_hub", "tuner_store", "tuner_hub", "analytics_hub"):
        assert not hasattr(app.state, legacy)
    paths = {r.path for r in app.routes}
    for p in ("/games/{game_id}/slot-model", "/games/{game_id}/slot-model/curate",
              "/games/{game_id}/tuner", "/games/{game_id}/tuner/tune",
              "/games/{game_id}/tuner/apply", "/analytics/runs",
              "/slot-model/templates",
              "/games/{game_id}/slot-model/apply-template"):
        assert p in paths, p
```

- [ ] **Step 7: Green the suite**

Run: `cd studio/backend && uv run pytest -m "not e2e"`
Expected: PASS. Iterate on residual import/signature errors — the mapping table covers them all; anything else is a missed rename. Then confirm the sweep is clean:
`grep -rn "app\.simulator\|app\.tuner\|app\.analytics" studio/backend --include="*.py"` → no output.

- [ ] **Step 8: Commit**

```bash
git add -A studio/backend
git commit -m "refactor(math)!: merge simulator+tuner+analytics into app/math; unified doc; template seeding; drop scene DEMO fallback"
```

(The `!` marks the internal breaking change — module paths and state names; external wire contracts are unchanged.)

---

### Task 6: Generate pipeline (tune → verify → persist verdict)

**Files:**

- Modify: `studio/backend/app/math/hub.py`, `app/math/rest.py`, `app/agent_tools.py` (one line), `tests/test_math_wiring.py` (one route assert)
- Test: `studio/backend/tests/test_math_generate.py`

**Interfaces:**

- Consumes: `MathHub.request_tune(record=False)`, `record_run(verify=...)`, `MathRunDoc.verify` (all already built).
- Produces: `MathHub.generate(game_id) -> bool` (await-to-completion; `False` if a run is already active), `MathHub.begin_generate(game_id) -> bool` (fire-and-forget for the REST route), `POST /games/{game_id}/math/generate` (202 / 409), socket event `generate_status {gameId, phase}` with phases `tuning | verifying | done | failed` (additive — no existing event changes).

- [ ] **Step 1: Write the failing tests**

`studio/backend/tests/test_math_generate.py` — self-contained (its own small fakes; the check-real-runner fakes come from the runner modules):

```python
import asyncio
from types import SimpleNamespace

import pytest

from app.math.hub import MathHub
from app.math.models import CurationResult, MetricsWire, TuneResult
from app.math.runners.curate import FakeCurationRunner
from app.math.runners.tune import FakeTunerRunner
from app.math.store import MathRunStore, MathStore


class FakeSio:
    def __init__(self):
        self.emits: list[tuple[str, dict]] = []

    async def emit(self, event, payload, room=None, to=None):
        self.emits.append((event, payload))

    async def enter_room(self, sid, room):
        pass

    def phases(self):
        return [p["phase"] for e, p in self.emits if e == "generate_status"]

    def count(self, event):
        return sum(1 for e, _ in self.emits if e == event)


class FakeGdd:
    """Returns a complete math-model intent (or None when empty=True)."""

    def __init__(self, empty=False):
        self._empty = empty

    async def get_doc(self, game_id, aspect):
        if self._empty:
            return None
        return SimpleNamespace(data={"rtp": 0.96, "volatility": "medium",
                                     "bonus_hit_rate": "1:150"})


class RecordingCurationRunner:
    def __init__(self, result):
        self._result = result
        self.models: list[dict] = []

    async def run(self, model, target, on_progress):
        self.models.append(model)
        return self._result


class GatedTunerRunner:
    def __init__(self, result):
        self._result = result
        self.gate = asyncio.Event()

    async def run(self, seed_model, target, config, on_progress):
        await self.gate.wait()
        return self._result


def _metrics():
    return MetricsWire(rtp=0.96, volatility=4.0, hit_frequency=0.3,
                       base_rtp=0.8, feature_rtp=0.16, bonus_hit_rates=[])


def _pass_tune():
    return TuneResult(status="pass", verdict="pass", tuned_model={"rows": 7},
                      metrics=_metrics(), ran_at="t1")


def _pass_curation():
    return CurationResult(status="pass", metrics=_metrics(), ran_at="t2")


def _hub(mongo_db, sio, *, tuner_runner, curation_runner, gdd=None):
    store = MathStore(mongo_db)
    runs = MathRunStore(mongo_db)
    return MathHub(sio, store, runs, curation_runner, tuner_runner,
                   gdd or FakeGdd()), store, runs


@pytest.mark.asyncio
async def test_generate_runs_tune_then_verify_and_persists_one_run(mongo_db):
    sio = FakeSio()
    hub, store, runs = _hub(mongo_db, sio,
                            tuner_runner=FakeTunerRunner(result=_pass_tune()),
                            curation_runner=FakeCurationRunner(result=_pass_curation()))
    assert await hub.generate("g1") is True
    docs = await runs.list_for_game("g1")
    assert len(docs) == 1
    assert docs[0].verdict == "pass"
    assert docs[0].verify.status == "pass"
    assert (await store.get("g1")).tune_result.tuned_model == {"rows": 7}
    assert sio.phases() == ["tuning", "verifying", "done"]
    assert sio.count("run_complete") == 1


@pytest.mark.asyncio
async def test_generate_verifies_the_tuned_model_not_the_stored_model(mongo_db):
    sio = FakeSio()
    recorder = RecordingCurationRunner(_pass_curation())
    hub, store, _ = _hub(mongo_db, sio,
                         tuner_runner=FakeTunerRunner(result=_pass_tune()),
                         curation_runner=recorder)
    await hub.generate("g1")
    assert recorder.models == [{"rows": 7}]          # the WINNER, not doc.model
    assert (await store.get("g1")).result is None    # stored-model slot untouched
    assert sio.count("curation_complete") == 0       # no simulator-pane events


@pytest.mark.asyncio
async def test_generate_failed_tune_skips_verify(mongo_db):
    sio = FakeSio()
    recorder = RecordingCurationRunner(_pass_curation())
    failed = TuneResult(status="error", failure="boom", ran_at="t1")
    hub, _, runs = _hub(mongo_db, sio,
                        tuner_runner=FakeTunerRunner(result=failed),
                        curation_runner=recorder)
    assert await hub.generate("g1") is True
    assert recorder.models == []
    assert await runs.list_for_game("g1") == []
    assert sio.phases() == ["tuning", "failed"]
    assert sio.count("tuning_failed") == 1


@pytest.mark.asyncio
async def test_generate_target_gap_reports_failed(mongo_db):
    sio = FakeSio()
    hub, _, runs = _hub(mongo_db, sio,
                        tuner_runner=FakeTunerRunner(result=_pass_tune()),
                        curation_runner=FakeCurationRunner(result=_pass_curation()),
                        gdd=FakeGdd(empty=True))
    assert await hub.generate("g1") is True
    assert await runs.list_for_game("g1") == []
    assert sio.phases() == ["tuning", "failed"]


@pytest.mark.asyncio
async def test_second_generate_while_active_returns_false(mongo_db):
    sio = FakeSio()
    gated = GatedTunerRunner(_pass_tune())
    hub, _, runs = _hub(mongo_db, sio, tuner_runner=gated,
                        curation_runner=FakeCurationRunner(result=_pass_curation()))
    first = asyncio.create_task(hub.generate("g1"))
    await asyncio.sleep(0)                    # let the first reserve + park
    assert await hub.generate("g1") is False  # agent-tool path rejected
    assert hub.begin_generate("g1") is False  # route path rejected
    gated.gate.set()
    assert await first is True
    assert len(await runs.list_for_game("g1")) == 1
```

If `FakeTunerRunner` / `FakeCurationRunner` constructor signatures differ from `result=` keyword (check the moved runner modules), match their actual signatures — the old test files show the working invocations. The route-level 202/409 case goes in `tests/test_math_rest.py` using its existing harness: POST `/games/g1/math/generate` → 202 while idle; with `GatedTunerRunner` parked → 409.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd studio/backend && uv run pytest tests/test_math_generate.py -v`
Expected: FAIL — `AttributeError: 'MathHub' object has no attribute 'generate'`

- [ ] **Step 3: Implement in `app/math/hub.py`**

Add to `MathHub`:

```python
    # ── generate pipeline: tune → verify → persist (spec sub-project 1) ──────
    def begin_generate(self, game_id: str) -> bool:
        """Fire-and-forget entry for the REST route. False if already running."""
        if not self._reserve(game_id):
            return False
        asyncio.create_task(self._generate_reserved(game_id))
        return True

    async def generate(self, game_id: str) -> bool:
        """Run the full pipeline to completion (agent-tool entry).
        False if a run for this game is already in flight."""
        if not self._reserve(game_id):
            return False
        return await self._generate_reserved(game_id)

    def _reserve(self, game_id: str) -> bool:
        if game_id in self._active:
            return False
        self._active.add(game_id)
        return True

    async def _status(self, game_id: str, phase: str) -> None:
        await self._sio.emit("generate_status",
                             {"gameId": game_id, "phase": phase}, room=game_id)

    async def _generate_reserved(self, game_id: str) -> bool:
        try:
            await self._status(game_id, "tuning")
            started = time.monotonic()
            result = await self.request_tune(game_id, record=False)
            duration_ms = int((time.monotonic() - started) * 1000)
            if result is None or result.status not in ("pass", "near_miss"):
                await self._status(game_id, "failed")
                return True
            await self._status(game_id, "verifying")
            verify = await self._verify_tuned(game_id, result.tuned_model)
            doc = await self._store.get(game_id)
            await self.record_run(game_id, doc.tuner_params, result, duration_ms,
                                  verify=verify)
            await self._status(game_id, "done")
            return True
        finally:
            self._active.discard(game_id)

    async def _verify_tuned(self, game_id: str, tuned_model: dict) -> CurationResult:
        """Independent curate pass on the WINNER (not the stored model). Does not
        touch doc.result and emits no curation_* events — the simulator pane's
        contract stays 'result == last curation of the stored model'."""
        doc = await self._store.get_or_seed(game_id)
        target = await self._derive_target(game_id, doc)

        def _noop(p):
            pass

        return await self._curation_runner.run(tuned_model, target,
                                               on_progress=_noop)
```

Note: `_verify_tuned` re-derives the target with the STORED doc's params but the tuned model's `num_bonuses` come from `doc.model` — the tuned model has the same bonus count (the genome never adds/removes bonuses), so this is safe; add that as a code comment.

- [ ] **Step 4: Add the route in `app/math/rest.py`**

```python
@router.post("/games/{game_id}/math/generate", status_code=202)
async def generate_math(game_id: str, request: Request) -> Response:
    if not request.app.state.math_hub.begin_generate(game_id):
        raise HTTPException(status_code=409,
                            detail="a math run is already in progress for this game")
    return Response(status_code=202)
```

Add `"/games/{game_id}/math/generate"` to the route list in `tests/test_math_wiring.py`.

- [ ] **Step 5: Upgrade the agent tool (text unchanged)**

In `build_tune_slot_model_tool` (agent_tools.py) replace the single call line:

```python
        await ctx.math_hub.request_tune(ctx.game_id)   # runs GA, streams to the pane
```

with:

```python
        # Full pipeline: GA tune + automatic verify pass on the winner. The
        # tool's report text is unchanged (replay cassettes are prompt-keyed).
        ok = await ctx.math_hub.generate(ctx.game_id)
        if not ok:
            return ("A math run is already in progress for this game — wait for "
                    "it to finish, then tune again.")
```

(The busy branch is a NEW return string — acceptable because no existing cassette exercises a concurrent tune; every existing path's text is untouched.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd studio/backend && uv run pytest tests/test_math_generate.py tests/test_tuner_tools.py tests/test_math_wiring.py -v` → PASS
Run: `uv run pytest -m "not e2e"` → all green.

- [ ] **Step 7: Commit**

```bash
git add studio/backend/app/math studio/backend/app/agent_tools.py studio/backend/tests
git commit -m "feat(math): backend-owned generate pipeline (tune -> verify -> persist verdict) with 409 concurrency guard"
```

---

### Task 7: Freeze tuned template models

**Files:**

- Create: `studio/backend/tools/freeze_template.py`
- Modify: `studio/backend/app/math/templates.py` (replace the three `_*` model literals with tuner output)
- Test: `studio/backend/tests/test_math_templates_binary.py` (e2e-marked)

**Interfaces:**

- Consumes: `templates.get_model`, `app.math.bounds.build_config/derive_bounds`, `app.math.runners.tune.SubprocessTunerRunner`, `app.math.runners.curate.SubprocessCurationRunner`.
- Produces: template model literals that measurably hit their stated targets; `TEMPLATE_TARGETS` (exported from `tools/freeze_template.py` and imported by the binary test so script and test share one target table).

- [ ] **Step 1: Write the freeze script**

`studio/backend/tools/freeze_template.py`:

```python
"""One-shot: tune a template's seed model to its stated target and print the
tuned model JSON to stdout. The frozen output is pasted into
app/math/templates.py so a fresh game is born near-target (spec decision 5).

Usage (from studio/backend, cargo toolchain required):
    uv run python tools/freeze_template.py video-5x3 > video-5x3.tuned.json
"""
import asyncio
import json
import sys

from app.config import get_settings
from app.math import templates
from app.math.bounds import build_config, derive_bounds
from app.math.models import default_tuning_params
from app.math.runners.tune import SubprocessTunerRunner

TEMPLATE_TARGETS: dict[str, dict] = {
    "classic-3x3": {
        "rtp_target": 0.96, "rtp_tolerance": 0.01,
        "volatility_min": 0.0, "volatility_max": 3.0,
        "bonus_hit_rate_bands": [],
        "pool_size": 1000, "candidate_count": 50_000,
        "realized_correction_band": 0.05, "master_seed": 2026,
    },
    "video-5x3": {
        "rtp_target": 0.96, "rtp_tolerance": 0.01,
        "volatility_min": 3.0, "volatility_max": 6.0,
        "bonus_hit_rate_bands": [{"min": (1 / 150) * 0.75, "max": (1 / 150) * 1.25}],
        "pool_size": 1000, "candidate_count": 50_000,
        "realized_correction_band": 0.05, "master_seed": 2026,
    },
    "high-vol-5x4": {
        "rtp_target": 0.96, "rtp_tolerance": 0.01,
        "volatility_min": 10.0, "volatility_max": 1e9,
        "bonus_hit_rate_bands": [{"min": (1 / 200) * 0.75, "max": (1 / 200) * 1.25}],
        "pool_size": 1000, "candidate_count": 50_000,
        "realized_correction_band": 0.05, "master_seed": 2026,
    },
}


async def main(name: str) -> None:
    seed = templates.get_model(name)
    target = TEMPLATE_TARGETS[name]
    params = default_tuning_params().model_copy(update={"max_generations": 80})
    config = build_config(params, derive_bounds(seed))
    runner = SubprocessTunerRunner(get_settings())

    def progress(p):
        print(f"gen {p.generation}/{p.max_generations} "
              f"fitness {p.best_fitness:.4f} rtp {p.best_rtp:.4f}", file=sys.stderr)

    result = await runner.run(seed, target, config, on_progress=progress)
    if result.status not in ("pass", "near_miss") or not result.tuned_model:
        raise SystemExit(f"tune failed: {result.status} {result.failure}")
    m = result.metrics
    print(f"verdict={result.verdict} rtp={m.rtp} vol={m.volatility} "
          f"hit={m.hit_frequency}", file=sys.stderr)
    print(json.dumps(result.tuned_model, indent=2))


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1]))
```

- [ ] **Step 2: Write the failing binary tests**

`studio/backend/tests/test_math_templates_binary.py`:

```python
"""Shells out to the real curate binary to prove each shipped template measures
at its stated target. e2e-marked (needs the cargo toolchain); deterministic +
offline. Mirrors tests/test_sim_curate_binary.py."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from freeze_template import TEMPLATE_TARGETS  # noqa: E402

from app.config import get_settings
from app.math import templates
from app.math.runners.curate import SubprocessCurationRunner


@pytest.mark.e2e
@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["classic-3x3", "video-5x3", "high-vol-5x4"])
async def test_template_curates_to_its_stated_target(name):
    runner = SubprocessCurationRunner(get_settings())
    res = await runner.run(templates.get_model(name), TEMPLATE_TARGETS[name],
                           on_progress=lambda p: None)
    assert res.status == "pass", f"{name}: {res.status} {res.failure}"
```

Run: `cd studio/backend && uv run pytest tests/test_math_templates_binary.py -m e2e -v`
Expected: FAIL (the hand-authored seed literals are not on target). If `classic-3x3` already passes, fine — the other two won't.

- [ ] **Step 3: Freeze each template**

For each of `classic-3x3`, `video-5x3`, `high-vol-5x4` (release cargo build kicks in on first run; several minutes each):

```bash
cd studio/backend
uv run python tools/freeze_template.py classic-3x3   > classic.tuned.json
uv run python tools/freeze_template.py video-5x3     > video.tuned.json
uv run python tools/freeze_template.py high-vol-5x4  > high.tuned.json
```

Paste each tuned JSON over the corresponding `_CLASSIC_3X3` / `_VIDEO_5X3` / `_HIGH_VOL_5X4` literal in `app/math/templates.py` (convert JSON casing: `false`→`False`, `null`→`None`; update the "seed version" comments to "frozen tuner output, <verdict>, measured rtp=<x> vol=<y>"). Delete the scratch `*.tuned.json` files.

If a tune lands `near_miss` instead of `pass`: bump `max_generations` to 160 in the script and rerun; if still near-miss, relax that template's seed (more mid-tier paytable entries gives the GA room) and rerun. Do not ship a near-miss literal.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd studio/backend && uv run pytest tests/test_math_templates_binary.py -m e2e -v` → PASS (all three)
Run: `uv run pytest tests/test_math_templates.py tests/test_math_store.py -v` → still PASS (structure tests are payout-agnostic; the genome preserves symbol sets, reel count, rows, paylines).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/tools/freeze_template.py studio/backend/app/math/templates.py studio/backend/tests/test_math_templates_binary.py
git commit -m "feat(math): freeze tuner-produced template models at their stated targets"
```

---

### Task 8: Frontend e2e (seeded fresh game) + full verification battery

**Files:**

- Modify: `studio/frontend/e2e/game-config.spec.ts` (add one test)
- Test: the entire repo.

**Interfaces:**

- Consumes: the seeded backend (`GET /games/{id}/slot-model` self-seeds video-5x3), existing spec helpers (`seedLocalStorage`, `BACKEND`, `openGameConfig`, `getModelDoc`).

- [ ] **Step 1: Add the spec**

Append to `studio/frontend/e2e/game-config.spec.ts` (reusing that file's existing helpers — note this test deliberately does NOT call `setupGame`, which PUTs a model):

```typescript
test('a fresh game is born with the default template (never empty)', async ({ page, request }) => {
  // No slot-model PUT: the doc must self-seed with video-5x3 on first read.
  const roomName = `gc-seeded ${Date.now()}`;
  const resp = await request.post(`${BACKEND}/rooms`, { data: { name: roomName } });
  expect(resp.ok()).toBeTruthy();
  const room = (await resp.json()) as { id: string; gameId: string };
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username: 'eve' } }));
  await page.goto('/');
  await expect(page.getByTestId('room-picker')).toBeVisible();
  await page.getByTestId('room-picker').getByText(roomName, { exact: true }).click();
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
  await openGameConfig(page);

  // video-5x3: 5 reels x 3 rows, 7 symbols (6 normals + scatter).
  await expect(page.getByTestId('gc-stat-window')).toHaveText('5 × 3');
  await expect(page.getByTestId('gc-stat-symbols')).toHaveText('7');

  // Persisted end-state, not just the UI echo (repo testing rule).
  const doc = await getModelDoc(request, room.gameId);
  expect(doc.model.reels).toHaveLength(5);
  expect(doc.model.paytable.entries.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run the backend + the e2e suite (worktree ports!)**

In one shell (leave running): `cd C:\code\bloom.wt\math-consolidation && just backend-serve-replay` (offset 1 → :8001, db `bloom_studio_wt1`).
In another: `cd C:\code\bloom.wt\math-consolidation && BLOOM_PORT_OFFSET=1 just e2e`
Expected: full Playwright suite green — including the untouched `simulator.spec.ts`, `math-analytics-*.spec.ts`, `reels.spec.ts`, `tuner-chat.spec.ts`, `llm-chat` suites, which are the proof that routes/events/tool-texts survived the merge. Triage any red as a real regression (this is the acceptance bar from the spec).

- [ ] **Step 3: Full gate battery**

```bash
cd C:\code\bloom.wt\math-consolidation
cd studio/backend && uv run pytest -m "not e2e" && uv run pytest -m e2e   # unit + binaries
cd ../.. && cargo test --workspace && cargo fmt --all -- --check          # Rust untouched but proven
node_modules/.bin/prettier --check .
```

Then the frontend gates: open `.github/workflows/` (the CI **Frontend** job) and run its four commands verbatim — prettier check, typecheck, vitest, build. vitest green alone is NOT sufficient (typecheck has caught what vitest masked before). All four must pass.

- [ ] **Step 4: Commit**

```bash
git add studio/frontend/e2e/game-config.spec.ts
git commit -m "test(e2e): fresh game is born with the seeded default template"
```

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin feat/math-consolidation
gh pr create --title "feat(math): unified math backend (app/math) with template seeding + generate pipeline" --body "Sub-project 1 of docs/superpowers/specs/2026-07-03-math-consolidation-design.md. Merges app/simulator+app/tuner+app/analytics into app/math; unifies the slot_models doc (tuner_params + locks + tune_result); seeds new games with a tuned video-5x3 template; deletes the scene DEMO fallback; adds the tune->verify->persist generate pipeline. All routes, socket events, and agent-tool texts preserved."
```

---

## Self-review checklist (run after writing, fixed inline)

- Spec coverage: module merge (T4/T5), unified doc + migration (T1/T3), templates + seeding + fallback deletion (T2/T3/T5/T7), generate pipeline (T6), routes/events preserved (T4/T5, proven T8), new e2e (T8). Locks are stored + respected by apply-template (T2/T4) but not GA-enforced — that is sub-project 2, per spec.
- The spec's doc sketch omits `tune_result`; it is required to preserve the `/tuner` wire (apply + PR-#99 rehydration) and honors the one-document goal. Recorded here as a deliberate addendum.
- The spec says "startup migration in `MathStore` init"; this plan does the same backfill **lazily on first read** instead (`build()` is sync — no async hook at construction; per-doc `$set` on `get()` is idempotent and covers the same docs). Functionally identical outcome, deliberately recorded.
- Type consistency: `MathStore.put(tuner_params=, locks=)` (T3) matches T4 rest + T5 agent-tools call sites; `request_tune(record=...)` (T4) matches T6; `TEMPLATE_TARGETS` (T7) shared by script + binary test.

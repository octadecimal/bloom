import pytest

import app.agent_tools as agent_tools
from app.agent_tools import (
    ToolContext,
    build_read_tuner_setup_tool,
    build_tune_math_tool,
    build_apply_tuned_math_tool,
    build_set_tuner_params_tool,
)
from app.compose import templates
from app.compose.store import ComposeStore
from app.math.store import MathStore, MathRunStore
from app.math.models import MetricsWire
from app.math.runners.tune import FakeTunerRunner, TuneProgress
from app.math.runners.curate import FakeCurationRunner
from app.math.models import CurationResult, TuneResult, BandMissWire
from app.math.hub import MathHub


class _StubGddDoc:
    def __init__(self, data): self.data = data


class _StubGddStore:
    def __init__(self, data): self._data = data
    async def get_doc(self, game_id, key): return _StubGddDoc(self._data)


def _ctx(mongo_db, *, gdd_data):
    return ToolContext(
        "r1", "g1", None, None,
        gdd_store=_StubGddStore(gdd_data),
        math_store=MathStore(mongo_db),
    )


@pytest.mark.asyncio
async def test_read_tuner_setup_reports_params_and_target(mongo_db):
    # get_or_seed always seeds the default template (video-5x3, 1 bonus) — spec
    # decision 5, a game's model is never {} — so the GDD intent must include
    # bonus_hit_rate for target derivation to succeed.
    ctx = _ctx(mongo_db, gdd_data={"rtp": "0.94", "volatility": "high",
                                   "bonus_hit_rate": "1:150"})
    await ctx.math_store.get_or_seed("g1")
    tool = build_read_tuner_setup_tool(ctx)
    out = await tool.ainvoke({})
    assert "population" in out.lower()
    assert "0.94" in out                            # derived RTP target
    assert "no tune has run" in out.lower()         # no result yet


async def _composed_ctx(mongo_db, *, gdd_data):
    compose = ComposeStore(mongo_db)
    # A deliberate write — family() requires touched=True, not just doc
    # existence (a bare get_or_seed auto-seed must not read as composed@1).
    await compose.put("g1", definition=templates.default_definition())
    return ToolContext(
        "r1", "g1", None, None,
        gdd_store=_StubGddStore(gdd_data),
        math_store=MathStore(mongo_db, compose_store=compose, gdd_store=None),
    )


@pytest.mark.asyncio
async def test_read_tuner_setup_reports_composed_shape(mongo_db):
    ctx = await _composed_ctx(mongo_db, gdd_data={"rtp": "0.94", "volatility": "high"})
    tool = build_read_tuner_setup_tool(ctx)
    out = await tool.ainvoke({})
    assert "Composed" in out and "states" in out


@pytest.mark.asyncio
async def test_apply_tuned_math_composed_routes_through_compose_store(mongo_db, monkeypatch):
    monkeypatch.setattr(agent_tools, "interrupt", lambda payload: "approve")
    events = []

    async def on_change(doc, source):
        events.append((doc.game_id, source))

    compose = ComposeStore(mongo_db, on_change=on_change)
    # A deliberate write — family() requires touched=True, not just doc
    # existence (a bare get_or_seed auto-seed must not read as composed@1).
    await compose.put("g1", definition=templates.default_definition())
    math_store = MathStore(mongo_db, compose_store=compose, gdd_store=None)
    ctx = ToolContext("r1", "g1", None, None, math_store=math_store)
    tuned = {"family": "composed@1", "mechanics": [], "states": [], "start": "base", "transitions": []}
    await math_store.save_tune_result("g1", TuneResult(
        status="pass", verdict="pass", tuned_model=tuned, metrics=_metrics(0.94),
        missed=[], trace=[], ran_at="t1"))
    events.clear()
    tool = build_apply_tuned_math_tool(ctx)
    out = await tool.ainvoke({})
    assert "applied" in out.lower()
    doc = await math_store.get("g1")
    assert doc.model == tuned
    assert events == [("g1", "tuner")]   # composed apply fires the compose on_change


@pytest.mark.asyncio
async def test_read_tuner_setup_reports_gap_when_intent_missing(mongo_db):
    ctx = _ctx(mongo_db, gdd_data={})               # no rtp/volatility -> TargetGap
    await ctx.math_store.get_or_seed("g1")
    tool = build_read_tuner_setup_tool(ctx)
    out = await tool.ainvoke({})
    assert "missing required intent" in out.lower()


def _params_ctx(mongo_db):
    return ToolContext("r1", "g1", None, None, math_store=MathStore(mongo_db))


@pytest.mark.asyncio
async def test_set_tuner_params_patches_only_given_fields(mongo_db):
    ctx = _params_ctx(mongo_db)
    seeded = await ctx.math_store.get_or_seed("g1")
    tool = build_set_tuner_params_tool(ctx)
    out = await tool.ainvoke({"population": 48, "weight_rtp": 2.0})
    doc = await ctx.math_store.get("g1")
    assert doc.tuner_params.population == 48
    assert doc.tuner_params.weights.rtp == 2.0
    assert doc.tuner_params.max_generations == seeded.tuner_params.max_generations   # untouched
    assert doc.tuner_params.weights.volatility == seeded.tuner_params.weights.volatility
    assert "48" in out


@pytest.mark.asyncio
async def test_set_tuner_params_rejects_nonpositive_without_writing(mongo_db):
    ctx = _params_ctx(mongo_db)
    await ctx.math_store.get_or_seed("g1")
    tool = build_set_tuner_params_tool(ctx)
    out = await tool.ainvoke({"population": 0})
    assert "must be positive" in out.lower()
    doc = await ctx.math_store.get("g1")
    assert doc.tuner_params.population != 0       # no write happened


# --- Finding 1: new guard tests for rate/weight knobs ---

@pytest.mark.asyncio
async def test_set_tuner_params_rejects_crossover_rate_below_zero(mongo_db):
    ctx = _params_ctx(mongo_db)
    seeded = await ctx.math_store.get_or_seed("g1")
    tool = build_set_tuner_params_tool(ctx)
    out = await tool.ainvoke({"crossover_rate": -0.5})
    assert "no change made" in out.lower()
    assert "crossover_rate" in out
    doc = await ctx.math_store.get("g1")
    assert doc.tuner_params.crossover_rate == seeded.tuner_params.crossover_rate   # no write


@pytest.mark.asyncio
async def test_set_tuner_params_rejects_mutation_rate_above_one(mongo_db):
    ctx = _params_ctx(mongo_db)
    seeded = await ctx.math_store.get_or_seed("g1")
    tool = build_set_tuner_params_tool(ctx)
    out = await tool.ainvoke({"mutation_rate": 1.5})
    assert "no change made" in out.lower()
    assert "mutation_rate" in out
    doc = await ctx.math_store.get("g1")
    assert doc.tuner_params.mutation_rate == seeded.tuner_params.mutation_rate   # no write


@pytest.mark.asyncio
async def test_set_tuner_params_rejects_negative_weight_rtp(mongo_db):
    ctx = _params_ctx(mongo_db)
    seeded = await ctx.math_store.get_or_seed("g1")
    tool = build_set_tuner_params_tool(ctx)
    out = await tool.ainvoke({"weight_rtp": -1.0})
    assert "no change made" in out.lower()
    assert "weight_rtp" in out
    doc = await ctx.math_store.get("g1")
    assert doc.tuner_params.weights.rtp == seeded.tuner_params.weights.rtp   # no write


@pytest.mark.asyncio
async def test_set_tuner_params_accepts_in_range_mutation_rate(mongo_db):
    ctx = _params_ctx(mongo_db)
    await ctx.math_store.get_or_seed("g1")
    tool = build_set_tuner_params_tool(ctx)
    out = await tool.ainvoke({"mutation_rate": 0.3})
    assert "no change made" not in out.lower()
    doc = await ctx.math_store.get("g1")
    assert doc.tuner_params.mutation_rate == 0.3


@pytest.mark.asyncio
async def test_set_tuner_params_accepts_zero_weight(mongo_db):
    ctx = _params_ctx(mongo_db)
    await ctx.math_store.get_or_seed("g1")
    tool = build_set_tuner_params_tool(ctx)
    out = await tool.ainvoke({"weight_rtp": 0.0})
    assert "no change made" not in out.lower()
    doc = await ctx.math_store.get("g1")
    assert doc.tuner_params.weights.rtp == 0.0


# --- end Finding 1 new tests ---


@pytest.mark.asyncio
async def test_set_tuner_params_accepts_hit_frequency_weight(mongo_db):
    ctx = _params_ctx(mongo_db)
    await ctx.math_store.get_or_seed("g1")
    tool = build_set_tuner_params_tool(ctx)
    out = await tool.ainvoke({"weight_hit_frequency": 2.0})
    doc = await ctx.math_store.get("g1")
    assert doc.tuner_params.weights.hit_frequency == 2.0
    assert "hit-freq" in out or "hit_frequency" in out


@pytest.mark.asyncio
async def test_set_tuner_params_rejects_negative_hit_frequency_weight(mongo_db):
    ctx = _params_ctx(mongo_db)
    seeded = await ctx.math_store.get_or_seed("g1")
    tool = build_set_tuner_params_tool(ctx)
    out = await tool.ainvoke({"weight_hit_frequency": -1.0})
    assert "no change made" in out.lower()
    doc = await ctx.math_store.get("g1")
    assert doc.tuner_params.weights.hit_frequency == seeded.tuner_params.weights.hit_frequency


class _FakeSio:
    def __init__(self): self.events = []
    async def enter_room(self, sid, room): pass
    async def emit(self, event, data, **kw): self.events.append((event, data))


def _metrics(rtp): return MetricsWire(rtp=rtp, volatility=8.0, hit_frequency=0.3,
                                      base_rtp=rtp, feature_rtp=0.0, bonus_hit_rates=[])


def _tune_ctx(mongo_db, *, result):
    store = MathStore(mongo_db)
    run_store = MathRunStore(mongo_db)
    # get_or_seed always seeds the default template (video-5x3, 1 bonus) — spec
    # decision 5, a game's model is never {} — so the GDD intent must include
    # bonus_hit_rate for target derivation to succeed.
    gdd = _StubGddStore({"rtp": "0.94", "volatility": "high", "bonus_hit_rate": "1:150"})
    runner = FakeTunerRunner(
        progress=[TuneProgress(1, 40, 0.5, 0.90, 8.0)], result=result)
    # tune_slot_model now runs the full generate() pipeline (GA tune + verify),
    # so the hub needs a real curation runner for the verify sub-step even
    # though these tests only assert on the tune_result / report text.
    curation_runner = FakeCurationRunner(progress=[], result=CurationResult(
        status="pass", metrics=_metrics(0.94), ran_at="t1"))
    hub = MathHub(_FakeSio(), store, run_store, curation_runner, runner, gdd)
    return ToolContext("r1", "g1", None, None, gdd_store=gdd,
                       math_store=store, math_hub=hub)


@pytest.mark.asyncio
async def test_tune_slot_model_reports_pass(mongo_db):
    passing = TuneResult(status="pass", verdict="pass", tuned_model={"reels": []},
                         metrics=_metrics(0.94), missed=[], trace=[], ran_at="t1")
    ctx = _tune_ctx(mongo_db, result=passing)
    await ctx.math_store.get_or_seed("g1")
    tool = build_tune_math_tool(ctx)
    out = await tool.ainvoke({})
    assert "pass" in out.lower()
    assert "0.94" in out
    saved = await ctx.math_store.get("g1")
    assert saved.tune_result.tuned_model == {"reels": []}    # request_tune persisted it


@pytest.mark.asyncio
async def test_tune_slot_model_reports_near_miss_with_missed_bands(mongo_db):
    near = TuneResult(status="near_miss", verdict="near_miss", tuned_model={"reels": []},
                      metrics=_metrics(0.91),
                      missed=[BandMissWire(metric="rtp", measured=0.91,
                                           band_lo=0.93, band_hi=0.95)],
                      trace=[], ran_at="t1")
    ctx = _tune_ctx(mongo_db, result=near)
    await ctx.math_store.get_or_seed("g1")
    tool = build_tune_math_tool(ctx)
    out = await tool.ainvoke({})
    assert "near" in out.lower()
    assert "rtp" in out.lower() and "0.91" in out


@pytest.mark.asyncio
async def test_tune_slot_model_reports_gap_without_running(mongo_db):
    ctx = _tune_ctx(mongo_db, result=None)              # runner result unused
    ctx.gdd_store = _StubGddStore({})                   # missing intent -> TargetGap
    await ctx.math_store.get_or_seed("g1")
    tool = build_tune_math_tool(ctx)
    out = await tool.ainvoke({})
    assert "missing required intent" in out.lower()
    saved = await ctx.math_store.get("g1")
    assert saved is None or saved.tune_result is None        # never ran


async def _seed_result_with_model(store, model):
    await store.get_or_seed("g1")
    await store.save_tune_result("g1", TuneResult(
        status="pass", verdict="pass", tuned_model=model, metrics=_metrics(0.94),
        missed=[], trace=[], ran_at="t1"))


def _apply_ctx(mongo_db):
    return ToolContext("r1", "g1", None, None, math_store=MathStore(mongo_db))


@pytest.mark.asyncio
async def test_apply_tuned_model_approve_writes_back(mongo_db, monkeypatch):
    monkeypatch.setattr(agent_tools, "interrupt", lambda payload: "approve")
    ctx = _apply_ctx(mongo_db)
    await ctx.math_store.get_or_seed("g1")
    await _seed_result_with_model(ctx.math_store, {"reels": [["A"]]})
    tool = build_apply_tuned_math_tool(ctx)
    out = await tool.ainvoke({})
    assert "applied" in out.lower()
    doc = await ctx.math_store.get("g1")
    assert doc.model == {"reels": [["A"]]}


@pytest.mark.asyncio
async def test_apply_tuned_model_deny_leaves_model_unchanged(mongo_db, monkeypatch):
    monkeypatch.setattr(agent_tools, "interrupt", lambda payload: "deny")
    ctx = _apply_ctx(mongo_db)
    seeded = await ctx.math_store.get_or_seed("g1")
    await _seed_result_with_model(ctx.math_store, {"reels": [["A"]]})
    tool = build_apply_tuned_math_tool(ctx)
    out = await tool.ainvoke({})
    assert "declined" in out.lower()
    doc = await ctx.math_store.get("g1")
    assert doc.model == seeded.model


@pytest.mark.asyncio
async def test_apply_tuned_model_no_result_returns_friendly(mongo_db, monkeypatch):
    def _boom(payload): raise AssertionError("interrupt must not be called")
    monkeypatch.setattr(agent_tools, "interrupt", _boom)
    ctx = _apply_ctx(mongo_db)
    tool = build_apply_tuned_math_tool(ctx)
    out = await tool.ainvoke({})
    assert "run a tune first" in out.lower()


# --- Regression tests for read_tuner_setup num_bonuses safe default + composed gating ---

class _MultiKeyStubGddStore:
    """Stub that can return different docs based on key."""
    def __init__(self, docs): self._docs = docs
    async def get_doc(self, game_id, key):
        if key in self._docs:
            return _StubGddDoc(self._docs[key])
        return _StubGddDoc({})


@pytest.mark.asyncio
async def test_read_tuner_setup_slots_bonus_mismatch_returns_unavailable_not_unbound(mongo_db):
    # Slots game has 1 bonus, but GDD bonus-features declares 2 features.
    # derive_num_bonuses raises TargetGap; num_bonuses must have a safe default
    # before the try block or UnboundLocalError would be raised when seed_line
    # references it in the else branch.
    store = _MultiKeyStubGddStore({
        "bonus-features": {"features": [{"name": "a"}, {"name": "b"}]},
        "base": {"rtp": "0.94", "volatility": "high", "bonus_hit_rate": "1:150"}
    })
    ctx = ToolContext(
        "r1", "g1", None, None,
        gdd_store=store,
        math_store=MathStore(mongo_db),
    )
    await ctx.math_store.get_or_seed("g1")
    tool = build_read_tuner_setup_tool(ctx)
    out = await tool.ainvoke({})
    assert "unavailable" in out.lower()
    assert "seed model" in out.lower()  # should still include seed_line with safe default num_bonuses


@pytest.mark.asyncio
async def test_read_tuner_setup_composed_ignores_gdd_bonus_features(mongo_db):
    # Composed game with a populated bonus-features GDD doc must not
    # call derive_num_bonuses (which only applies to slots). The composed
    # seed_line doesn't reference num_bonuses; target derivation must succeed.
    ctx = await _composed_ctx(mongo_db,
                              gdd_data={
                                  "rtp": "0.94", "volatility": "high",
                                  "bonus-features": {"features": [{"name": "a"}, {"name": "b"}]}
                              })
    tool = build_read_tuner_setup_tool(ctx)
    out = await tool.ainvoke({})
    assert "composed" in out.lower()
    assert "states" in out
    # Should derive a target line (not UNAVAILABLE), since composed games
    # don't use derive_num_bonuses and derive_target_for handles composed targets.
    assert "target:" in out.lower() and "unavailable" not in out.lower()

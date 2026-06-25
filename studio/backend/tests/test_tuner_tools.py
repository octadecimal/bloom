import pytest

import app.agent_tools as agent_tools
from app.agent_tools import (
    ToolContext,
    build_read_tuner_setup_tool,
    build_tune_slot_model_tool,
    build_apply_tuned_model_tool,
    build_set_tuner_params_tool,
)
from app.simulator.store import SlotModelStore
from app.simulator.models import MetricsWire
from app.tuner.store import TunerStore
from app.tuner.hub import TunerHub
from app.tuner.runner import FakeTunerRunner, TuneProgress
from app.tuner.models import TuneResult, BandMissWire


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
    assert "missing required intent" in out.lower()


def _params_ctx(mongo_db):
    return ToolContext("r1", "g1", None, None, tuner_store=TunerStore(mongo_db))


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


# --- Finding 1: new guard tests for rate/weight knobs ---

@pytest.mark.asyncio
async def test_set_tuner_params_rejects_crossover_rate_below_zero(mongo_db):
    ctx = _params_ctx(mongo_db)
    seeded = await ctx.tuner_store.get_or_seed("g1")
    tool = build_set_tuner_params_tool(ctx)
    out = await tool.ainvoke({"crossover_rate": -0.5})
    assert "no change made" in out.lower()
    assert "crossover_rate" in out
    doc = await ctx.tuner_store.get("g1")
    assert doc.params.crossover_rate == seeded.params.crossover_rate   # no write


@pytest.mark.asyncio
async def test_set_tuner_params_rejects_mutation_rate_above_one(mongo_db):
    ctx = _params_ctx(mongo_db)
    seeded = await ctx.tuner_store.get_or_seed("g1")
    tool = build_set_tuner_params_tool(ctx)
    out = await tool.ainvoke({"mutation_rate": 1.5})
    assert "no change made" in out.lower()
    assert "mutation_rate" in out
    doc = await ctx.tuner_store.get("g1")
    assert doc.params.mutation_rate == seeded.params.mutation_rate   # no write


@pytest.mark.asyncio
async def test_set_tuner_params_rejects_negative_weight_rtp(mongo_db):
    ctx = _params_ctx(mongo_db)
    seeded = await ctx.tuner_store.get_or_seed("g1")
    tool = build_set_tuner_params_tool(ctx)
    out = await tool.ainvoke({"weight_rtp": -1.0})
    assert "no change made" in out.lower()
    assert "weight_rtp" in out
    doc = await ctx.tuner_store.get("g1")
    assert doc.params.weights.rtp == seeded.params.weights.rtp   # no write


@pytest.mark.asyncio
async def test_set_tuner_params_accepts_in_range_mutation_rate(mongo_db):
    ctx = _params_ctx(mongo_db)
    await ctx.tuner_store.get_or_seed("g1")
    tool = build_set_tuner_params_tool(ctx)
    out = await tool.ainvoke({"mutation_rate": 0.3})
    assert "no change made" not in out.lower()
    doc = await ctx.tuner_store.get("g1")
    assert doc.params.mutation_rate == 0.3


@pytest.mark.asyncio
async def test_set_tuner_params_accepts_zero_weight(mongo_db):
    ctx = _params_ctx(mongo_db)
    await ctx.tuner_store.get_or_seed("g1")
    tool = build_set_tuner_params_tool(ctx)
    out = await tool.ainvoke({"weight_rtp": 0.0})
    assert "no change made" not in out.lower()
    doc = await ctx.tuner_store.get("g1")
    assert doc.params.weights.rtp == 0.0


# --- end Finding 1 new tests ---


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
    assert "missing required intent" in out.lower()
    saved = await ctx.tuner_store.get("g1")
    assert saved is None or saved.result is None        # never ran


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

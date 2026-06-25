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

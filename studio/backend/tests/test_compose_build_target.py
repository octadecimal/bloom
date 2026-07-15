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
    # A deliberate write — family() requires touched=True, not just doc
    # existence (a bare get_or_seed auto-seed must not read as composed@1).
    await compose.put("g1", definition={"family": "composed@1"})
    target = await composed_build_target(gdd, math, "g1")
    assert target["rtp_target"] == 0.96
    assert target["bonus_hit_rate_bands"] == []
    assert "pay_constraints" not in target


@pytest.mark.asyncio
async def test_composed_build_target_none_on_gap(mongo_db):
    gdd = _FakeGddStore({})  # no math-model intent at all
    compose = ComposeStore(mongo_db)
    math = MathStore(mongo_db, compose_store=compose, gdd_store=gdd)
    await compose.put("g1", definition={"family": "composed@1"})
    assert await composed_build_target(gdd, math, "g1") is None


def test_build_job_carries_target(settings):
    job = build_job("g1", {}, {}, settings, target={"rtp_target": 0.96})
    assert job["target"] == {"rtp_target": 0.96}


def test_build_job_omits_target_when_none(settings):
    assert "target" not in build_job("g1", {}, {}, settings)

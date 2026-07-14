"""derive_target_for fetches all four GDD aspects and passes them through to
the pure compiler — proven by a pay constraint appearing in the output (it can
only get there via the paytable + symbols-reels docs)."""
import pytest
from types import SimpleNamespace

from app.math.models import default_params
from app.math.target_flow import derive_target_for


class _Doc:
    def __init__(self, data):
        self.data = data


class _GddStore:
    def __init__(self, docs: dict):
        self._docs = docs

    async def get_doc(self, game_id, aspect):
        data = self._docs.get(aspect)
        return _Doc(data) if data is not None else None


class _MathDoc:
    model = {"bonuses": []}
    params = default_params()


@pytest.mark.asyncio
async def test_derive_target_for_compiles_constraints_from_the_stores():
    store = _GddStore({
        "math-model": {"rtp": 0.96, "volatility": "medium", "hit_frequency": 0.3},
        "bonus-features": {},
        "paytable": {"pay_constraints": [{"symbol": "wild", "relation": "top-paying"}]},
        "symbols-reels": {"symbols": [{"slot": "wild", "name": "Rune", "model_id": 2}]},
    })
    target = await derive_target_for(store, "g1", _MathDoc())
    assert target["pay_constraints"] == [{"symbol": 2, "relation": "top-paying"}]
    assert "hit_frequency_band" in target


@pytest.mark.asyncio
async def test_derive_target_for_survives_missing_aspects():
    store = _GddStore({"math-model": {"rtp": 0.96, "volatility": "medium"}})
    target = await derive_target_for(store, "g1", _MathDoc())
    assert "pay_constraints" not in target


@pytest.mark.asyncio
async def test_composed_target_has_no_bonus_bands_or_pay_constraints():
    # Composed targets ignore bonus_hit_rate + pay constraints (composed
    # validate_constraints rejects them — #160 owns feature bands) and
    # pay-constraint join keys arrive with SP-D.
    COMPOSED_DEF = {
        "family": "composed@1",
        "mechanics": [{"id": "main_reels", "type": "reels@1", "config": {
            "paytable": {"entries": [{"symbol": 0, "count": 3, "payout": 50}]}}}],
        "states": [], "start": "base", "transitions": [],
    }
    store = _GddStore({
        "math-model": {"rtp": 0.96, "volatility": "low", "bonus_hit_rate": "1:100"},
        "paytable": {"pay_constraints": [{"symbol": "high1", "relation": "floor", "value": 5}]},
        "symbols-reels": {"symbols": [{"slot": "high1", "model_id": 0}]},
        "bonus-features": {"features": [{"name": "fs"}]},
    })
    doc = SimpleNamespace(model=COMPOSED_DEF, params=default_params())
    target = await derive_target_for(store, "g1", doc)
    assert target["bonus_hit_rate_bands"] == []
    assert "pay_constraints" not in target
    assert target["rtp_target"] == 0.96

"""derive_target_for fetches all four GDD aspects and passes them through to
the pure compiler — proven by a pay constraint appearing in the output (it can
only get there via the paytable + symbols-reels docs)."""
import pytest

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

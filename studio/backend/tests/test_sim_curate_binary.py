"""Shells out to the real Rust binary. Marked e2e so it stays out of the unit gate
(needs the cargo toolchain). Deterministic + offline — no cassettes."""
import pytest
from app.config import get_settings
from app.simulator.runner import SubprocessCurationRunner, CurationProgress

@pytest.mark.e2e
@pytest.mark.asyncio
async def test_real_curation_passes_for_known_model():
    model = {
        "symbols": [{"id": 0, "role": "normal"}, {"id": 1, "role": "normal"},
                    {"id": 2, "role": "normal"}],
        "reels": [[0, 0, 0, 0, 0, 1, 1, 1, 1, 2]], "rows": 1, "paylines": [[0]],
        "paytable": {"entries": [{"symbol": 1, "count": 1, "payout": 1},
                                 {"symbol": 2, "count": 1, "payout": 5}]},
        "bonuses": [],
    }
    target = {
        "rtp_target": 0.9, "rtp_tolerance": 0.02, "volatility_min": 0.0,
        "volatility_max": 1e9, "bonus_hit_rate_bands": [], "pool_size": 1000,
        "candidate_count": 20000, "realized_correction_band": 0.05, "master_seed": 2026,
    }
    seen: list[CurationProgress] = []
    runner = SubprocessCurationRunner(get_settings())
    res = await runner.run(model, target, on_progress=seen.append)
    assert res.status == "pass", res.failure
    assert abs(res.metrics.rtp - 0.9) < 0.02
    assert any(p.phase == "simulate" for p in seen)

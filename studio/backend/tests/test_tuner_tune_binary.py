"""Shells out to the real Rust tune_json binary. Marked e2e so it stays out of the
unit gate (needs the cargo toolchain). Deterministic + offline — no cassettes.
Build first for speed: `cargo build --release -p bloom-tuner --bin tune_json`."""
import pytest
from app.config import get_settings
from app.math.bounds import derive_bounds, build_config
from app.math.models import default_tuning_params
from app.math.runners.tune import SubprocessTunerRunner, TuneProgress

# Detuned: sym2 pays 1 -> RTP ~0.5. Target 0.9 -> the tuner must raise payouts.
DETUNED = {
    "symbols": [{"id": 0, "role": "normal"}, {"id": 1, "role": "normal"},
                {"id": 2, "role": "normal"}],
    "reels": [[0, 0, 0, 0, 0, 1, 1, 1, 1, 2]], "rows": 1, "paylines": [[0]],
    "paytable": {"entries": [{"symbol": 1, "count": 1, "payout": 1},
                             {"symbol": 2, "count": 1, "payout": 1}]},
    "bonuses": [],
}
TARGET_09 = {
    "rtp_target": 0.9, "rtp_tolerance": 0.02, "volatility_min": 0.0,
    "volatility_max": 1e9, "bonus_hit_rate_bands": [], "pool_size": 0,
    "candidate_count": 0, "realized_correction_band": 0.05,
}


def _fast_params():
    p = default_tuning_params()
    p.master_seed = 7
    p.population = 16
    p.max_generations = 40
    p.search_candidate_count = 5_000
    p.final_candidate_count = 50_000
    return p


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_real_tune_converges_to_pass():
    seen: list[TuneProgress] = []
    config = build_config(_fast_params(), derive_bounds(DETUNED))
    runner = SubprocessTunerRunner(get_settings())
    res = await runner.run(DETUNED, TARGET_09, config, on_progress=seen.append)
    assert res.status == "pass", res.failure
    assert abs(res.metrics.rtp - 0.9) <= 0.02
    assert seen and seen[0].generation == 0  # streamed at least one generation
    assert res.tuned_model is not None


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_all_locked_returns_structured_error():
    from app.math.models import SectionLocks
    config = build_config(_fast_params(), derive_bounds(DETUNED),
                          SectionLocks(reels=True, paytable=True, bonus=True))
    runner = SubprocessTunerRunner(get_settings())
    res = await runner.run(DETUNED, TARGET_09, config, on_progress=lambda p: None)
    assert res.status == "error"
    assert "locked" in (res.failure or "")

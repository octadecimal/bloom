"""Parity oracle: a realized SlotModel is fed to the REAL simulator binary and
must deserialize + evaluate. Proves the realizer emits the kernel's exact serde
shape without re-hosting the realizer in Rust. Marked e2e (needs the cargo
toolchain); offline + deterministic, no MongoDB, no cassettes.

A freshly-realized model is numerically rough, so we assert STRUCTURAL success
(the binary deserialized it and reached the simulate phase), not curation pass.
"""
import math

import pytest

from app.config import get_settings
from app.math.realize import realize_slot_model
from app.math.runners.curate import CurationProgress, SubprocessCurationRunner

_MATH = {"reels": 5, "rows": 3, "payline_mode": "lines", "payline_count": 5}
_SYMBOLS = {"symbols": [
    {"slot": "high1", "name": "Dragon", "kind": "high"},
    {"slot": "low1", "name": "Ten", "kind": "low"},
    {"slot": "wild", "name": "Rune", "kind": "wild"},
    {"slot": "scatter", "name": "Coin", "kind": "scatter"},
], "strip_length": {"min": 30, "max": 40}}
_PAYTABLE = {"pay_constraints": [
    {"symbol": "Dragon", "relation": "top-paying", "count": "5", "value": "100"},
    {"symbol": "Ten", "relation": "floor", "count": "3", "value": "10"},
]}
# retrigger is ON deliberately: this is the parity oracle's teeth. A retriggering
# free-spins feature on dense reels used to be a supercritical loop that drove the
# kernel's run_free_spins into unbounded memory (>2GiB in 0.4s, hung the OS). That
# root cause is now fixed on three layers — the kernel hard-caps total free spins
# (MAX_FREE_SPINS), the realizer seeds scatters SPARSELY so the model is
# subcritical, and the runner watchdog is the backstop — so a retriggering bonus
# must now curate to completion without OOM. Keeping retrigger ON makes this test
# an end-to-end regression guard for that fix. Full write-up:
# docs/superpowers/followups/2026-06-25-unbounded-free-spins-retrigger.md.
_BONUS = {"features": [
    {"name": "Free Spins", "trigger": "3 scatters", "description": "Spin 10 times with 2x multiplier"}]}

# A permissive target: we only need curation to RUN to completion, not to pass.
_TARGET = {
    "rtp_target": 0.9, "rtp_tolerance": 0.5, "volatility_min": 0.0,
    "volatility_max": 1e9, "bonus_hit_rate_bands": [{"min": 0.0, "max": 1.0}],
    "pool_size": 200, "candidate_count": 2000,
    "realized_correction_band": 0.5, "master_seed": 2026,
}


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_realized_model_is_structurally_valid_for_the_kernel():
    res = realize_slot_model(_MATH, _SYMBOLS, _PAYTABLE, _BONUS)
    assert res.model is not None, f"realize failed: {res.errors}"

    seen: list[CurationProgress] = []
    runner = SubprocessCurationRunner(get_settings())
    result = await runner.run(res.model, _TARGET, on_progress=seen.append)

    # Structural-validity oracle: the binary deserialized our model and evaluated
    # it (reached the simulate phase) and returned a finite RTP. We do NOT assert
    # curation passed — a rough model's numbers are the tuner's job (SP3).
    assert any(p.phase == "simulate" for p in seen), "binary never reached simulate"
    assert result is not None
    assert math.isfinite(result.metrics.rtp)

"""Auto-restart tune: wire models (Task 1) + pure loop helpers (Task 2).
Spec: docs/superpowers/specs/2026-07-06-auto-restart-tune-design.md"""
import math

import pytest

from app.math.bounds import build_config, derive_bounds
from app.math.models import (
    AttemptSummaryWire, MathRunDoc, MetricsWire, TuningParams,
    default_tuning_params, math_run_wire,
)
from app.math.restart import escalate, miss_score


def test_tuning_params_default_max_attempts_is_4():
    assert default_tuning_params().max_attempts == 4


def test_tuning_params_accepts_legacy_payload_without_max_attempts():
    data = default_tuning_params().model_dump()
    data.pop("max_attempts")
    assert TuningParams.model_validate(data).max_attempts == 4


def test_build_config_omits_max_attempts():
    # Python-only knob: it must never reach the Rust binary's config JSON.
    cfg = build_config(default_tuning_params(), derive_bounds({}))
    assert "max_attempts" not in cfg


def test_math_run_wire_carries_attempts_and_loop_stop():
    run = MathRunDoc(
        id="r1", game_id="g1", params=default_tuning_params(), created_at="t",
        attempts=[AttemptSummaryWire(attempt=1, verdict="near_miss",
                                     stop_reason="stagnated", miss_score=2.5)],
        loop_stop="attempts_exhausted",
    )
    wire = math_run_wire(run)
    assert wire["loopStop"] == "attempts_exhausted"
    assert wire["attempts"][0] == {"attempt": 1, "verdict": "near_miss",
                                   "stopReason": "stagnated", "missScore": 2.5}
    assert wire["params"]["maxAttempts"] == 4


def test_math_run_wire_legacy_run_has_null_attempts():
    run = MathRunDoc(id="r1", game_id="g1", params=default_tuning_params(),
                     created_at="t")
    wire = math_run_wire(run)
    assert wire["attempts"] is None
    assert wire["loopStop"] is None


# Task 2: Pure restart helpers — escalation + miss score


def _cfg(seed=2026, mutation=0.25):
    return {"master_seed": seed, "mutation_rate": mutation, "population": 24,
            "bounds": {"payout_max": 20}}


def _m(rtp=0.96, vol=4.0, bonus=None):
    return MetricsWire(rtp=rtp, volatility=vol, hit_frequency=0.3, base_rtp=rtp,
                       feature_rtp=0.0, bonus_hit_rates=bonus or [])


TARGET = {"rtp_target": 0.96, "rtp_tolerance": 0.01,
          "volatility_min": 3.0, "volatility_max": 6.0,
          "bonus_hit_rate_bands": []}


def test_escalate_attempt_1_is_the_config_verbatim_and_a_copy():
    cfg = _cfg()
    out = escalate(cfg, 1)
    assert out == cfg
    assert out is not cfg  # caller's config never mutated


def test_escalate_increments_seed_and_compounds_mutation():
    out2 = escalate(_cfg(), 2)
    assert out2["master_seed"] == 2027
    assert out2["mutation_rate"] == pytest.approx(0.375)   # 0.25 * 1.5
    out3 = escalate(_cfg(), 3)
    assert out3["master_seed"] == 2028
    assert out3["mutation_rate"] == pytest.approx(0.5)     # 0.5625 capped at 0.5
    assert out3["population"] == 24                        # only seed+mutation change
    assert out3["bounds"] == {"payout_max": 20}


def test_miss_score_zero_when_all_gates_in_band():
    assert miss_score(_m(), TARGET) == 0.0


def test_miss_score_normalizes_by_band_width():
    # rtp band (0.95, 0.97), width 0.02; measured 0.90 → (0.95-0.90)/0.02 = 2.5
    assert miss_score(_m(rtp=0.90), TARGET) == pytest.approx(2.5)


def test_miss_score_sums_gates():
    # rtp miss 2.5 + vol 7.0 over (3,6): (7-6)/3 ≈ 0.3333
    assert miss_score(_m(rtp=0.90, vol=7.0), TARGET) == pytest.approx(2.5 + 1.0 / 3.0)


def test_miss_score_open_ended_volatility_band_normalizes_by_its_edge():
    # 'high' volatility → (10, 1e9): width 1e9 would zero-out the miss; use lo.
    target = dict(TARGET, volatility_min=10.0, volatility_max=1e9)
    assert miss_score(_m(vol=5.0), target) == pytest.approx((10.0 - 5.0) / 10.0)


def test_miss_score_includes_bonus_bands():
    target = dict(TARGET, bonus_hit_rate_bands=[{"min": 0.005, "max": 0.007}])
    # measured 0.009 → (0.009-0.007)/0.002 = 1.0
    assert miss_score(_m(bonus=[0.009]), target) == pytest.approx(1.0)


def test_miss_score_missing_metrics_is_infinite():
    assert miss_score(None, TARGET) == math.inf

"""Auto-restart tune: wire models (Task 1) + pure loop helpers (Task 2).
Spec: docs/superpowers/specs/2026-07-06-auto-restart-tune-design.md"""
from app.math.bounds import build_config, derive_bounds
from app.math.models import (
    AttemptSummaryWire, MathRunDoc, TuningParams, default_tuning_params,
    math_run_wire,
)


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

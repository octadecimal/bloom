from app.analytics.models import (
    MathRunDoc,
    PopulationStatsWire,
    HistogramBinWire,
    WinDistributionWire,
    TailWire,
    RtpPointWire,
    RunProfileWire,
    math_run_wire,
)
from app.simulator.models import MetricsWire
from app.tuner.models import TuningParams, TuneWeights, default_tuning_params


def _params() -> TuningParams:
    return default_tuning_params()


def _metrics() -> MetricsWire:
    return MetricsWire(
        rtp=0.95,
        volatility=3.2,
        hit_frequency=0.25,
        base_rtp=0.7,
        feature_rtp=0.25,
        bonus_hit_rates=[0.01],
    )


def _profile() -> RunProfileWire:
    return RunProfileWire(
        distribution=WinDistributionWire(
            bins=[HistogramBinWire(bin_lo=0.0, bin_hi=1.0, base=10, feature=2)],
            zero_count=5,
        ),
        tail=TailWire(
            max_win=500.0,
            p_ge100x=0.28,
            p_losing_spin=0.4,
            longest_dead_streak=12,
            bonus_trigger_rate=0.02,
        ),
        rtp_convergence=[RtpPointWire(n=100, realized_rtp=0.9)],
    )


def test_math_run_round_trips_camelcase():
    doc = MathRunDoc(
        id="r1",
        game_id="g1",
        params=_params(),
        verdict="pass",
        metrics=_metrics(),
        trace=[],
        profile=_profile(),
        created_at="2026-07-02T00:00:00Z",
        duration_ms=1234,
    )
    wire = math_run_wire(doc)
    assert wire["gameId"] == "g1"
    assert wire["profile"]["tail"]["pGE100x"] == 0.28
    assert wire["durationMs"] == 1234
    # populate_by_name: validating the camelCase wire back yields an equal doc
    assert MathRunDoc.model_validate(wire).game_id == "g1"


def test_population_stats_round_trips():
    pop = PopulationStatsWire(min=0.1, q1=0.2, median=0.3, q3=0.4, max=0.5, mean=0.3, diversity=0.05)
    wire = pop.model_dump(by_alias=True)
    assert wire["q1"] == 0.2 and wire["diversity"] == 0.05

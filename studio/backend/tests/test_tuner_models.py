from app.tuner.models import (
    TuningParams, TuneWeights, TuneResult, BandMissWire, GenSnapshotWire,
    default_tuning_params, tuner_wire, TunerJobDoc,
)
from app.simulator.models import MetricsWire


def test_default_params_are_sane():
    p = default_tuning_params()
    assert p.population > 0
    assert p.search_candidate_count < p.final_candidate_count
    assert isinstance(p.weights, TuneWeights)


def test_params_round_trip_camel_case():
    p = default_tuning_params()
    raw = p.model_dump(by_alias=True)
    assert "masterSeed" in raw and "searchCandidateCount" in raw
    assert raw["weights"]["hitRate"] == p.weights.hit_rate
    again = TuningParams.model_validate(raw)
    assert again == p


def test_tune_result_near_miss_holds_missed_and_trace():
    r = TuneResult(
        status="near_miss", verdict="near_miss",
        tuned_model={"reels": [[0, 1]]},
        metrics=MetricsWire(rtp=0.8, volatility=3.0, hit_frequency=0.3,
                            base_rtp=0.8, feature_rtp=0.0, bonus_hit_rates=[]),
        missed=[BandMissWire(metric="rtp", measured=0.8, band_lo=0.89, band_hi=0.91)],
        trace=[GenSnapshotWire(generation=0, best_fitness=-0.5, best_rtp=0.5, best_volatility=2.0)],
        ran_at="t",
    )
    wire = r.model_dump(by_alias=True)
    assert wire["missed"][0]["bandLo"] == 0.89
    assert wire["trace"][0]["bestFitness"] == -0.5
    assert wire["tunedModel"] == {"reels": [[0, 1]]}


def test_tuner_wire_uses_aliases():
    doc = TunerJobDoc(id="x", game_id="g1", params=default_tuning_params(),
                      result=None, created_at="t", updated_at="t")
    w = tuner_wire(doc)
    assert w["gameId"] == "g1" and w["result"] is None

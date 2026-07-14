"""Unified wire models. Merges the coverage of the old test_sim_models /
test_tuner_models / test_analytics_models (those files are deleted in Task 5)."""
from app.math.models import (
    SlotModelDoc, SectionLocks, MathRunDoc, TuneResult, MetricsWire,
    GenSnapshotWire, TailWire, HistogramBinWire, CurationResult,
    default_params, default_tuning_params, sim_wire, tuner_view, math_run_wire,
    TUNER_TOOL_NAMES,
)


def _metrics() -> MetricsWire:
    return MetricsWire(rtp=0.96, volatility=4.2, hit_frequency=0.3,
                       base_rtp=0.8, feature_rtp=0.16, bonus_hit_rates=[0.006])


def _doc(**over) -> SlotModelDoc:
    base = dict(id="d1", game_id="g1", model={"rows": 3}, params=default_params(),
                created_at="t0", updated_at="t1")
    base.update(over)
    return SlotModelDoc.model_validate(base)


def test_unified_doc_defaults_new_fields():
    doc = _doc()
    assert doc.tuner_params == default_tuning_params()
    assert doc.locks == SectionLocks()
    assert doc.locks.reels is False and doc.locks.paytable is False and doc.locks.bonus is False
    assert doc.tune_result is None
    assert doc.presentation == {}
    assert doc.result is None


def test_legacy_shaped_doc_still_validates():
    # A doc written before this change has none of the new keys.
    raw = {"id": "d1", "game_id": "g1", "model": {}, "params":
           default_params().model_dump(mode="json"),
           "created_at": "t0", "updated_at": "t1"}
    doc = SlotModelDoc.model_validate(raw)
    assert doc.tuner_params.population == 24


def test_sim_wire_is_camel_and_excludes_tune_result():
    tr = TuneResult(status="pass", verdict="pass", tuned_model={"rows": 3},
                    metrics=_metrics(), ran_at="t2")
    wire = sim_wire(_doc(tune_result=tr))
    assert wire["gameId"] == "g1"
    assert "tunerParams" in wire and "locks" in wire
    assert "tuneResult" not in wire  # editor wire stays slim; /tuner carries it


def test_tuner_view_synthesizes_legacy_tuner_wire():
    tr = TuneResult(status="near_miss", verdict="near_miss",
                    tuned_model={"rows": 3}, metrics=_metrics(), ran_at="t2")
    view = tuner_view(_doc(tune_result=tr))
    assert set(view) == {"id", "gameId", "params", "result", "createdAt", "updatedAt"}
    assert view["params"]["maxGenerations"] == 40
    assert view["result"]["tunedModel"] == {"rows": 3}
    assert view["result"]["metrics"]["hitFrequency"] == 0.3


def test_tuner_view_with_no_result():
    assert tuner_view(_doc())["result"] is None


def test_math_run_doc_carries_optional_verify():
    run = MathRunDoc(id="r1", game_id="g1", params=default_tuning_params(),
                     created_at="t0")
    assert run.verify is None
    verified = MathRunDoc(id="r2", game_id="g1", params=default_tuning_params(),
                          verify=CurationResult(status="pass", metrics=_metrics(),
                                                ran_at="t3"),
                          created_at="t0")
    wire = math_run_wire(verified)
    assert wire["verify"]["status"] == "pass"


def test_tail_wire_pge100x_alias_round_trip():
    tail = TailWire(max_win=500.0, **{"pGE100x": 0.001},
                    p_losing_spin=0.7, longest_dead_streak=30, bonus_trigger_rate=0.006)
    assert tail.model_dump(by_alias=True, mode="json")["pGE100x"] == 0.001


def test_histogram_bin_hi_none_survives():
    b = HistogramBinWire(bin_lo=100.0, bin_hi=None, base=3, feature=1)
    assert b.model_dump(by_alias=True, mode="json")["binHi"] is None


def test_gen_snapshot_defaults():
    s = GenSnapshotWire(generation=1, best_fitness=0.5, best_rtp=0.9,
                        best_volatility=4.0)
    assert s.population.diversity == 0.0
    assert s.gene_agreement == []


def test_tuner_tool_names_are_family_neutral():
    assert TUNER_TOOL_NAMES == {"read_tuner_setup", "set_tuner_params",
                                "tune_math", "apply_tuned_math"}

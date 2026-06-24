from app.simulator.models import (
    CurationParams, SlotModelDoc, default_params, sim_wire,
)

def test_default_params_are_sane():
    p = default_params()
    assert p.pool_size > 0 and p.candidate_count >= p.pool_size
    assert 0 < p.rtp_tolerance < 1

def test_sim_wire_is_camel_cased():
    doc = SlotModelDoc(
        id="d1", game_id="g1", model={"reels": []}, params=default_params(),
        result=None, created_at="t", updated_at="t",
    )
    wire = sim_wire(doc)
    assert wire["gameId"] == "g1"
    assert wire["params"]["candidateCount"] == default_params().candidate_count
    assert "model" in wire

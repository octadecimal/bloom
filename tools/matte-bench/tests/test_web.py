import random

from fastapi.testclient import TestClient

from matte_bench import web
from matte_bench.web import app, state
from matte_bench.corpus import Subject
from matte_bench.store import Verdict


async def _noop_prepare(c):
    return None


def _client(tmp_path, monkeypatch=None):
    state.root = tmp_path
    state.subjects = [Subject(id="s1", bucket="wispy", prompt="p", seed=1,
                              width=8, height=8)]
    state.techniques = ["a", "b"]
    state.technique_objs = {}
    state.comfy_url = "http://unused"
    state.unavailable = {}
    state.verdict_log = tmp_path / "verdicts.jsonl"
    state.fault_log = tmp_path / "faults.jsonl"
    state.plate_hashes = {"s1": "h"}
    # Fixed seed: /api/next's repeat-injection branch fires ~1/20 calls with an
    # unseeded rng, which made test_posting_a_verdict_appends_and_advances flaky
    # (~4.5% of runs). Seed 1234 verified to not hit that branch for the calls
    # these tests make.
    state.rng = random.Random(1234)
    if monkeypatch is not None:
        monkeypatch.setattr(web, "_prepare", _noop_prepare)
    return TestClient(app)


def test_health(tmp_path):
    assert _client(tmp_path).get("/health").json()["status"] == "ok"


def test_next_returns_a_blind_comparison(tmp_path, monkeypatch):
    body = _client(tmp_path, monkeypatch).get("/api/next").json()
    assert body["subject"] == "s1"
    assert {body["left"], body["right"]} == {"a", "b"}


def test_posting_a_verdict_appends_and_advances(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    first = client.get("/api/next").json()
    resp = client.post("/api/verdict", json={
        "subject": first["subject"], "bucket": first["bucket"],
        "left": first["left"], "right": first["right"], "winner": "left",
    })
    assert resp.status_code == 200
    assert state.verdict_log.exists()
    assert client.get("/api/next").json() is None


def test_verdict_rejects_unknown_winner(tmp_path):
    client = _client(tmp_path)
    resp = client.post("/api/verdict", json={
        "subject": "s1", "bucket": "wispy", "left": "a", "right": "b",
        "winner": "sideways",
    })
    assert resp.status_code == 422


def test_standings_endpoint_reports_the_leader(tmp_path):
    client = _client(tmp_path)
    for _ in range(6):
        client.post("/api/verdict", json={
            "subject": "s1", "bucket": "wispy", "left": "a", "right": "b",
            "winner": "left",
        })
    body = client.get("/api/standings/wispy").json()
    assert body["rows"][0]["technique"] == "a"


def test_standings_endpoint_reports_not_separated_on_thin_evidence(tmp_path):
    """The endpoint must surface separated(), not just the raw rows: a couple
    of verdicts is not enough evidence for a real lead."""
    client = _client(tmp_path)
    for _ in range(2):
        client.post("/api/verdict", json={
            "subject": "s1", "bucket": "wispy", "left": "a", "right": "b",
            "winner": "left",
        })
    body = client.get("/api/standings/wispy").json()
    assert body["separated"] is False


def test_render_serves_a_file_inside_the_renders_dir(tmp_path):
    client = _client(tmp_path)
    target = tmp_path / "renders" / "s1" / "abc.png"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"\x89PNG\r\n\x1a\n")
    resp = client.get("/render/s1/abc.png")
    assert resp.status_code == 200
    assert resp.content == b"\x89PNG\r\n\x1a\n"


def test_render_refuses_percent_encoded_escape(tmp_path):
    """httpx collapses a literal '..' segment before dispatch, so the escape
    must be percent-encoded to actually reach the handler."""
    client = _client(tmp_path)
    outside = tmp_path / "secret.png"
    outside.write_bytes(b"nope")
    resp = client.get("/render/%2e%2e/secret.png")
    assert resp.status_code == 404
    assert b"nope" not in resp.content


def test_api_render_guard_rejects_traversal_directly(tmp_path):
    """Exercises the containment guard itself, independent of how any client
    or router normalises the URL."""
    import pytest
    from fastapi import HTTPException

    from matte_bench.web import api_render

    _client(tmp_path)  # installs state.root = tmp_path
    outside = tmp_path / "secret.png"
    outside.write_bytes(b"nope")
    with pytest.raises(HTTPException) as excinfo:
        api_render("..", "secret")
    assert excinfo.value.status_code == 404


def test_plate_serves_a_file_inside_the_plates_dir(tmp_path):
    client = _client(tmp_path)
    target = tmp_path / "plates" / "s1.png"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"\x89PNG\r\n\x1a\n")
    resp = client.get("/plate/s1.png")
    assert resp.status_code == 200
    assert resp.content == b"\x89PNG\r\n\x1a\n"


def test_api_plate_guard_rejects_traversal_directly(tmp_path):
    """Exercises the containment guard itself, mirroring the api_render guard
    test above."""
    import pytest
    from fastapi import HTTPException

    from matte_bench.web import api_plate

    _client(tmp_path)  # installs state.root = tmp_path
    outside = tmp_path / "secret.png"
    outside.write_bytes(b"nope")
    with pytest.raises(HTTPException) as excinfo:
        api_plate("..")
    assert excinfo.value.status_code == 404


def test_next_drops_a_render_error_technique_and_does_not_offer_it_again(tmp_path, monkeypatch):
    """Discovered lazily: a RenderError must remove that technique from
    rotation and record it in /api/unavailable, never silently."""
    from matte_bench.render import RenderError
    from matte_bench.techniques import Technique

    client = _client(tmp_path, monkeypatch)
    bad = Technique(id="birefnet-hr", cls="A", node="BiRefNetRMBG",
                    model="BiRefNet-HR", params={}, post=())
    good1 = Technique(id="rmbg-2", cls="A", node="RMBG", model="RMBG-2.0",
                      params={}, post=())
    good2 = Technique(id="rmbg-1", cls="A", node="RMBG", model="RMBG-1.4",
                      params={}, post=())
    state.techniques = ["hash-bad", "hash-good1", "hash-good2"]
    state.technique_objs = {"hash-bad": bad, "hash-good1": good1, "hash-good2": good2}

    calls = {"n": 0}

    async def flaky_prepare(c):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RenderError("birefnet-hr", "weights missing")
        return None

    monkeypatch.setattr(web, "_prepare", flaky_prepare)

    body = client.get("/api/next").json()
    assert body is not None
    assert "hash-bad" not in state.techniques
    assert state.unavailable == {"birefnet-hr": "weights missing"}
    assert client.get("/api/unavailable").json() == {"birefnet-hr": "weights missing"}

    # The dropped technique must never be offered again.
    for _ in range(10):
        nxt = client.get("/api/next").json()
        if nxt is None:
            break
        assert "hash-bad" not in (nxt["left"], nxt["right"])

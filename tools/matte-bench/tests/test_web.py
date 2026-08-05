from fastapi.testclient import TestClient

from matte_bench.web import app, state
from matte_bench.corpus import Subject
from matte_bench.store import Verdict


def _client(tmp_path):
    state.root = tmp_path
    state.subjects = [Subject(id="s1", bucket="wispy", prompt="p", seed=1,
                              width=8, height=8)]
    state.techniques = ["a", "b"]
    state.verdict_log = tmp_path / "verdicts.jsonl"
    state.fault_log = tmp_path / "faults.jsonl"
    state.plate_hashes = {"s1": "h"}
    return TestClient(app)


def test_health(tmp_path):
    assert _client(tmp_path).get("/health").json()["status"] == "ok"


def test_next_returns_a_blind_comparison(tmp_path):
    body = _client(tmp_path).get("/api/next").json()
    assert body["subject"] == "s1"
    assert {body["left"], body["right"]} == {"a", "b"}


def test_posting_a_verdict_appends_and_advances(tmp_path):
    client = _client(tmp_path)
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
    rows = client.get("/api/standings/wispy").json()
    assert rows[0]["technique"] == "a"


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

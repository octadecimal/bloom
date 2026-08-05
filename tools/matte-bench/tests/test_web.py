import random
import time

from fastapi.testclient import TestClient

from matte_bench import web
from matte_bench.web import app, state
from matte_bench.corpus import Subject
from matte_bench.store import Verdict


async def _noop_prepare(c, progress):
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
    state.job = None
    # Fixed seed: /api/next's repeat-injection branch fires ~1/20 calls with an
    # unseeded rng, which made test_posting_a_verdict_appends_and_advances flaky
    # (~4.5% of runs). Seed 1234 verified to not hit that branch for the calls
    # these tests make.
    state.rng = random.Random(1234)
    if monkeypatch is not None:
        monkeypatch.setattr(web, "_prepare", _noop_prepare)
    return TestClient(app)


def _await_next(client, timeout=5.0):
    """Poll /api/next until the job resolves; the comparison dict, or None
    when the session is exhausted."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        body = client.get("/api/next").json()
        if body["status"] == "ready":
            return body["comparison"]
        if body["status"] == "done":
            return None
        assert body["status"] == "pending", body
        time.sleep(0.01)
    raise AssertionError("job never resolved")


def test_health(tmp_path):
    assert _client(tmp_path).get("/health").json()["status"] == "ok"


def test_index_is_served_with_no_store(tmp_path):
    resp = _client(tmp_path).get("/")
    assert resp.headers.get("cache-control") == "no-store"


def test_api_responses_are_served_with_no_store(tmp_path):
    client = _client(tmp_path)
    for path in ("/api/techniques", "/api/unavailable", "/api/standings/wispy"):
        assert client.get(path).headers.get("cache-control") == "no-store", path


def test_next_returns_a_blind_comparison(tmp_path, monkeypatch):
    body = _await_next(_client(tmp_path, monkeypatch))
    assert body["subject"] == "s1"
    assert {body["left"], body["right"]} == {"a", "b"}


def test_next_reports_progress_while_a_render_is_in_flight(tmp_path, monkeypatch):
    """The whole point of the job protocol: while images generate, /api/next
    answers immediately with what the server is doing instead of hanging."""
    import threading

    gate = threading.Event()

    async def slow_prepare(c, progress):
        progress("rendering candidate 1 of 2…")
        gate.wait(10)

    client = _client(tmp_path)
    monkeypatch.setattr(web, "_prepare", slow_prepare)
    try:
        deadline = time.time() + 5
        while time.time() < deadline:
            body = client.get("/api/next").json()
            if body["status"] == "pending" and "rendering" in body.get("progress", ""):
                break
            assert body["status"] == "pending", body
            time.sleep(0.01)
        else:
            raise AssertionError("never saw render progress while job blocked")
    finally:
        gate.set()
    assert _await_next(client)["subject"] == "s1"


def test_prepare_progress_never_names_a_technique(tmp_path, monkeypatch):
    """Progress text is shown to the judge mid-comparison, so it must not
    leak which technique is on which side — the comparison is blind."""
    import asyncio

    from matte_bench.pairing import Comparison
    from matte_bench.techniques import Technique

    _client(tmp_path)
    left = Technique(id="birefnet-hr", cls="A", node="BiRefNetRMBG",
                     model="BiRefNet-HR", params={}, post=())
    right = Technique(id="rmbg-2", cls="A", node="RMBG", model="RMBG-2.0",
                      params={}, post=())
    state.techniques = ["hash-l", "hash-r"]
    state.technique_objs = {"hash-l": left, "hash-r": right}

    async def fake_plate(subject, root, url):
        # The real ensure_plate guarantees the file exists on return.
        from matte_bench.corpus import plate_path
        p = plate_path(root, subject.id)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"plate")
        return p

    async def fake_render(s, t, root, url):
        return None

    monkeypatch.setattr(web, "ensure_plate", fake_plate)
    monkeypatch.setattr(web, "ensure_render", fake_render)

    seen = []
    asyncio.run(web._prepare(
        Comparison(subject="s1", bucket="wispy", left="hash-l", right="hash-r"),
        seen.append))
    assert seen, "prepare reported no progress at all"
    for msg in seen:
        for leak in ("hash-l", "hash-r", "birefnet-hr", "rmbg-2",
                     "BiRefNet-HR", "RMBG-2.0"):
            assert leak not in msg, f"{leak!r} leaked into progress: {msg!r}"


def test_verdict_succeeds_for_a_subject_plated_mid_session(tmp_path, monkeypatch):
    """plate_hashes is computed at bootstrap, when lazily-plated subjects have
    no plate yet. A vote on one must still be recorded — this exact gap made
    /api/verdict 404 and silently discarded every verdict of a session."""
    from matte_bench.corpus import plate_hash, plate_path
    from matte_bench.store import read_verdicts

    client = _client(tmp_path)
    state.plate_hashes = {}

    async def fake_plate(subject, root, url):
        p = plate_path(root, subject.id)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"fresh plate")
        return p

    async def fake_render(s, t, root, url):
        return None

    monkeypatch.setattr(web, "ensure_plate", fake_plate)
    monkeypatch.setattr(web, "ensure_render", fake_render)

    first = _await_next(client)
    resp = client.post("/api/verdict", json={
        "subject": first["subject"], "bucket": first["bucket"],
        "left": first["left"], "right": first["right"], "winner": "left",
    })
    assert resp.status_code == 200
    recorded = read_verdicts(state.verdict_log)
    assert len(recorded) == 1
    assert recorded[0].plate_hash == plate_hash(b"fresh plate")


def test_posting_a_verdict_appends_and_advances(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    first = _await_next(client)
    resp = client.post("/api/verdict", json={
        "subject": first["subject"], "bucket": first["bucket"],
        "left": first["left"], "right": first["right"], "winner": "left",
    })
    assert resp.status_code == 200
    assert state.verdict_log.exists()
    assert _await_next(client) is None


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

    async def flaky_prepare(c, progress):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RenderError("birefnet-hr", "weights missing")
        return None

    monkeypatch.setattr(web, "_prepare", flaky_prepare)

    body = _await_next(client)
    assert body is not None
    assert "hash-bad" not in state.techniques
    assert state.unavailable == {"birefnet-hr": "weights missing"}
    assert client.get("/api/unavailable").json() == {"birefnet-hr": "weights missing"}

    # The dropped technique must never be offered again.
    for _ in range(10):
        nxt = _await_next(client)
        if nxt is None:
            break
        assert "hash-bad" not in (nxt["left"], nxt["right"])

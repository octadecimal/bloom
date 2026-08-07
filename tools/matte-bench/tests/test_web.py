import asyncio
import random
import time

import pytest
from fastapi.testclient import TestClient

from matte_bench import web
from matte_bench.web import app, state, StagedEntry, PREFETCH_DEPTH
from matte_bench.corpus import Subject
from matte_bench.store import Verdict


async def _noop_prepare(c, progress):
    return None


def _client(tmp_path, monkeypatch=None):
    # Drain any background prefetch thread a previous test left running
    # before reassigning the state it reads/writes — otherwise it can still
    # be alive (or race the reassignment) when the next test starts, which
    # both flakes assertions and pollutes an unrelated test's temp dir.
    if state.prefetch is not None:
        state.prefetch.join(timeout=5)
    state.prefetch = None
    state.staged = []
    state.generation = 0
    state.root = tmp_path
    state.subjects = []
    state.templates = {"wispy": {"width": 8, "height": 8,
                                 "templates": [{"text": "a test tuft"}],
                                 "pools": {}}}
    state.subject_log = tmp_path / "subjects-sampled.jsonl"
    state.active_subject_id = None
    state.active_served = 0
    state.techniques = ["a", "b"]
    state.technique_objs = {}
    state.technique_names = {}
    # Both same-class so derive_cls resolves them like plain same-pixel
    # comparisons, matching every pre-existing test's implicit cls="A".
    state.technique_cls = {"a": "A", "b": "A"}
    state.comfy_url = "http://unused"
    # Reachable by default: outage classification is opt-in per test, and the
    # probe must never hit the network from the suite.
    state.comfy_probe = lambda url: None
    state.unavailable = {}
    state.verdict_log = tmp_path / "verdicts.jsonl"
    state.fault_log = tmp_path / "faults.jsonl"
    state.plate_hashes = {"s1": "h"}
    state.llm = None
    state.llm_model = ""
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


@pytest.fixture
def client_with_state(tmp_path):
    """A client with a mix of A- and B-class techniques and a plated subject,
    for the verdict-class / standings / techniques routes below. The verdict
    log lives under tmp_path (via _client), so each test starts empty."""
    client = _client(tmp_path)
    state.techniques = ["a1x", "a2x", "b1x", "b2x"]
    state.technique_cls = {"a1x": "A", "a2x": "A", "b1x": "B", "b2x": "B"}
    state.plate_hashes = {"s1": "h"}
    return client, state


@pytest.fixture
def bench_state(client_with_state):
    """Alias for client_with_state: state.techniques holds the four hashes
    {a1x, a2x, b1x, b2x} and state.technique_cls maps them to pools A/B, which
    is exactly what the class-aware serving helpers below need."""
    return client_with_state


def test_health(tmp_path):
    assert _client(tmp_path).get("/health").json()["status"] == "ok"


def test_index_is_served_with_no_store(tmp_path):
    resp = _client(tmp_path).get("/")
    assert resp.headers.get("cache-control") == "no-store"


def test_api_responses_are_served_with_no_store(tmp_path):
    client = _client(tmp_path)
    for path in ("/api/techniques", "/api/unavailable", "/api/standings/wispy"):
        assert client.get(path).headers.get("cache-control") == "no-store", path


def test_next_returns_a_blind_comparison_on_a_sampled_subject(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    body = _await_next(client)
    assert body["subject"].startswith("wispy-")
    assert {body["left"], body["right"]} == {"a", "b"}
    # The draw is registered so its verdicts stay attributable.
    assert state.subject_log.exists()
    assert body["subject"] in state.subject_log.read_text(encoding="utf-8")


def test_subject_rotates_after_pairs_per_subject(tmp_path, monkeypatch):
    """The generalized corpus in action: after PAIRS_PER_SUBJECT comparisons
    a FRESH random subject is sampled instead of re-serving the same image."""
    monkeypatch.setattr(web, "PAIRS_PER_SUBJECT", 1)
    client = _client(tmp_path, monkeypatch)
    first = _await_next(client)
    second = _await_next(client)
    assert first["subject"] != second["subject"]


def test_subject_is_reused_within_the_rotation_window(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    first = _await_next(client)
    second = _await_next(client)
    assert first["subject"] == second["subject"]


class _FakeLLM:
    def __init__(self, chunks):
        self._chunks = chunks

    async def stream(self, turns, model):
        for c in self._chunks:
            yield c


def test_llm_imagined_subject_is_used_when_configured(tmp_path, monkeypatch):
    monkeypatch.setattr(web, "TEMPLATE_MIX", 0.0)
    client = _client(tmp_path, monkeypatch)
    state.llm = _FakeLLM(["a soap bubble cluster with translucent film"])
    state.llm_model = "test-model"
    body = _await_next(client)
    subject = next(s for s in state.subjects if s.id == body["subject"])
    assert subject.prompt.startswith("a soap bubble cluster with translucent film, ")


def test_llm_garbage_falls_back_to_the_template_sampler(tmp_path, monkeypatch):
    monkeypatch.setattr(web, "TEMPLATE_MIX", 0.0)
    client = _client(tmp_path, monkeypatch)
    state.llm = _FakeLLM(["a ring floating in front of a busy scene"])
    state.llm_model = "test-model"
    body = _await_next(client)
    subject = next(s for s in state.subjects if s.id == body["subject"])
    assert subject.prompt.startswith("a test tuft, ")


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
    assert _await_next(client)["subject"].startswith("wispy-")


def test_pending_payload_reports_percent_and_stage(tmp_path, monkeypatch):
    """percent and stage ride along with the progress text so the page can
    draw a real progress bar over the side being rendered."""
    import threading

    gate = threading.Event()

    async def slow_prepare(c, progress):
        progress("rendering candidate 1 of 2…", 0.4, "render-1")
        gate.wait(10)

    client = _client(tmp_path)
    monkeypatch.setattr(web, "_prepare", slow_prepare)
    try:
        deadline = time.time() + 5
        while time.time() < deadline:
            body = client.get("/api/next").json()
            if body["status"] == "pending" and body.get("percent") == 0.4:
                assert body["stage"] == "render-1"
                break
            assert body["status"] == "pending", body
            time.sleep(0.01)
        else:
            raise AssertionError("never saw percent while job blocked")
    finally:
        gate.set()
    assert _await_next(client)["subject"].startswith("wispy-")


def test_prepare_maps_render_progress_to_sides(tmp_path, monkeypatch):
    """render-1 must always mean the LEFT side and render-2 the RIGHT, so the
    page can put the progress bar over the panel actually being computed."""
    import asyncio

    from matte_bench.pairing import Comparison
    from matte_bench.corpus import plate_path
    from matte_bench.techniques import Technique

    _client(tmp_path)
    state.subjects = [Subject(id="s1", bucket="wispy", prompt="p", seed=1,
                              width=8, height=8)]
    left = Technique(id="birefnet-hr", cls="A", node="BiRefNetRMBG",
                     model="BiRefNet-HR", params={}, post=())
    right = Technique(id="rmbg-2", cls="A", node="RMBG", model="RMBG-2.0",
                      params={}, post=())
    state.techniques = ["hash-l", "hash-r"]
    state.technique_objs = {"hash-l": left, "hash-r": right}
    plate_path(tmp_path, "s1").parent.mkdir(parents=True, exist_ok=True)
    plate_path(tmp_path, "s1").write_bytes(b"plate")

    async def fake_plate(subject, root, url, on_progress=None):
        return plate_path(root, subject.id)

    async def fake_render(s, t, root, url, on_progress=None):
        if on_progress is not None:
            on_progress(0.5)

    monkeypatch.setattr(web, "ensure_plate", fake_plate)
    monkeypatch.setattr(web, "ensure_render", fake_render)

    seen = []

    def collect(text, percent=None, stage=None):
        seen.append((percent, stage))

    asyncio.run(web._prepare(
        Comparison(subject="s1", bucket="wispy", left="hash-l", right="hash-r"),
        collect))
    assert (0.5, "render-1") in seen
    assert (0.5, "render-2") in seen


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
    state.subjects = [Subject(id="s1", bucket="wispy", prompt="p", seed=1,
                              width=8, height=8)]
    state.techniques = ["hash-l", "hash-r"]
    state.technique_objs = {"hash-l": left, "hash-r": right}

    async def fake_plate(subject, root, url, on_progress=None):
        # The real ensure_plate guarantees the file exists on return.
        from matte_bench.corpus import plate_path
        p = plate_path(root, subject.id)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"plate")
        return p

    async def fake_render(s, t, root, url, on_progress=None):
        return None

    monkeypatch.setattr(web, "ensure_plate", fake_plate)
    monkeypatch.setattr(web, "ensure_render", fake_render)

    seen = []

    def collect(text, percent=None, stage=None):
        seen.append(text)

    asyncio.run(web._prepare(
        Comparison(subject="s1", bucket="wispy", left="hash-l", right="hash-r"),
        collect))
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

    async def fake_plate(subject, root, url, on_progress=None):
        p = plate_path(root, subject.id)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"fresh plate")
        return p

    async def fake_render(s, t, root, url, on_progress=None):
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
    """Sampling never exhausts: after a verdict the bench serves the next
    comparison instead of running dry."""
    client = _client(tmp_path, monkeypatch)
    first = _await_next(client)
    state.plate_hashes[first["subject"]] = "h"
    resp = client.post("/api/verdict", json={
        "subject": first["subject"], "bucket": first["bucket"],
        "left": first["left"], "right": first["right"], "winner": "left",
    })
    assert resp.status_code == 200
    assert state.verdict_log.exists()
    assert _await_next(client) is not None


def test_both_bad_verdict_records_and_flags_both_techniques(tmp_path):
    """"Both are bad" carries two facts: no relative preference (a tie for
    ranking) and an absolute quality failure for EACH side — the latter goes
    to the fault log, which a plain tie must not touch."""
    from matte_bench.store import read_verdicts

    client = _client(tmp_path)
    resp = client.post("/api/verdict", json={
        "subject": "s1", "bucket": "wispy", "left": "a", "right": "b",
        "winner": "both_bad",
    })
    assert resp.status_code == 200
    assert read_verdicts(state.verdict_log)[0].winner == "both_bad"
    fault_lines = state.fault_log.read_text(encoding="utf-8").strip().splitlines()
    assert len(fault_lines) == 2
    assert "both-bad" in fault_lines[0]

    client.post("/api/verdict", json={
        "subject": "s1", "bucket": "wispy", "left": "a", "right": "b",
        "winner": "tie",
    })
    assert len(state.fault_log.read_text(encoding="utf-8").strip().splitlines()) == 2


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
    for _ in range(5):
        nxt = _await_next(client)
        assert nxt is not None
        assert "hash-bad" not in (nxt["left"], nxt["right"])


def test_progress_reports_totals_and_unseparated_bucket_without_winner(tmp_path):
    client = _client(tmp_path)
    for _ in range(2):
        client.post("/api/verdict", json={
            "subject": "s1", "bucket": "wispy", "left": "a", "right": "b",
            "winner": "left",
        })
    body = client.get("/api/progress").json()
    assert body["total"] == 2
    assert body["classes"] == [
        {"cls": "A", "total": 2, "buckets": [
            {"bucket": "wispy", "count": 2, "separated": False, "winner": None}]}]


def test_progress_names_the_winner_once_a_bucket_separates(tmp_path):
    client = _client(tmp_path)
    state.technique_names = {"a": "Node/BiRefNet_alpha"}
    for _ in range(10):
        client.post("/api/verdict", json={
            "subject": "s1", "bucket": "wispy", "left": "a", "right": "b",
            "winner": "left",
        })
    body = client.get("/api/progress").json()
    assert body["classes"][0]["buckets"][0]["separated"] is True
    assert body["classes"][0]["buckets"][0]["winner"] == "Node/BiRefNet_alpha"


def test_progress_counts_only_fresh_verdicts(tmp_path):
    """Stale verdicts (cast on an outdated plate) feed neither the rankings
    nor the displayed counts — the number watched is the number that decides."""
    client = _client(tmp_path)
    for _ in range(2):
        client.post("/api/verdict", json={
            "subject": "s1", "bucket": "wispy", "left": "a", "right": "b",
            "winner": "left",
        })
    state.plate_hashes["s1"] = "regenerated"  # invalidates both verdicts
    body = client.get("/api/progress").json()
    assert body["total"] == 0
    assert body["classes"] == []


def test_progress_is_served_with_no_store(tmp_path):
    assert (_client(tmp_path).get("/api/progress").headers.get("cache-control")
            == "no-store")


def test_verdict_records_derived_class(client_with_state):
    client, state = client_with_state
    resp = client.post("/api/verdict", json={
        "subject": "s1", "bucket": "wispy", "left": "b1x", "right": "b2x",
        "winner": "left"})
    assert resp.status_code == 200
    from matte_bench.store import read_verdicts
    [v] = read_verdicts(state.verdict_log)
    assert v.cls == "B"


def test_verdict_rejects_cross_class_non_champions(client_with_state):
    client, state = client_with_state
    resp = client.post("/api/verdict", json={
        "subject": "s1", "bucket": "wispy", "left": "a1x", "right": "b1x",
        "winner": "left"})
    assert resp.status_code == 422
    from matte_bench.store import read_verdicts
    assert read_verdicts(state.verdict_log) == []


def test_standings_route_takes_cls(client_with_state):
    client, _ = client_with_state
    assert client.get("/api/standings/wispy?cls=B").status_code == 200
    assert client.get("/api/standings/wispy?cls=Z").status_code == 422


def test_choose_comparison_serves_thinner_class(bench_state):
    """With A well-fed and B starved, the next comparison is class B."""
    from matte_bench.web import _choose_comparison, state
    # bench_state installs pools A: [a1x, a2x], B: [b1x, b2x]
    s = Subject(id="s1", bucket="wispy", prompt="p", seed=1, width=64, height=64)
    verdicts = [Verdict(subject="s1", bucket="wispy", left="a1x", right="a2x",
                        winner="left", plate_hash="h", ts="t")] * 4
    c, cls = _choose_comparison(s, verdicts, random.Random(7))
    assert cls == "B" and {c.left, c.right} == {"b1x", "b2x"}


def test_choose_comparison_serves_playoff_when_open(bench_state):
    from matte_bench.web import _choose_comparison
    s = Subject(id="s1", bucket="wispy", prompt="p", seed=1, width=64, height=64)
    verdicts = ([Verdict(subject="s1", bucket="wispy", left="a1x", right="a2x",
                         winner="left", plate_hash="h", ts="t")] * 12
                + [Verdict(subject="s1", bucket="wispy", left="b1x", right="b2x",
                           winner="left", plate_hash="h", ts="t", cls="B")] * 12)
    c, cls = _choose_comparison(s, verdicts, random.Random(7))
    assert cls == "X" and {c.left, c.right} == {"a1x", "b1x"}


def test_choose_comparison_ignores_playoff_when_a_champion_is_gone(bench_state):
    """playoff_pair derives champions from the verdict LOG alone; if one has
    since been dropped from the live registry (RenderError path removes it
    from state.techniques, but its past verdicts stay logged), serving the
    playoff would 422 forever at /api/verdict — losing votes and wedging the
    bucket, since X never accumulates and stays the thinnest class."""
    from matte_bench.web import _choose_comparison, state
    s = Subject(id="s1", bucket="wispy", prompt="p", seed=1, width=64, height=64)
    verdicts = ([Verdict(subject="s1", bucket="wispy", left="a1x", right="a2x",
                         winner="left", plate_hash="h", ts="t")] * 12
                + [Verdict(subject="s1", bucket="wispy", left="b1x", right="b2x",
                           winner="left", plate_hash="h", ts="t", cls="B")] * 12)
    # b1x is a champion per the verdict log, but no longer in the live
    # registry (as if a RenderError had just dropped it).
    state.techniques = ["a1x", "a2x", "a3x", "b2x"]
    state.technique_cls = {"a1x": "A", "a2x": "A", "a3x": "A", "b2x": "B"}
    c, cls = _choose_comparison(s, verdicts, random.Random(7))
    assert cls != "X"
    assert c is not None


def test_sample_fresh_redraws_on_id_collision(tmp_path, monkeypatch):
    """Simulates the race the RNG-clone prefetcher can create: the demand
    fallback and the prefetch's rng clone independently mint the same
    bucket-seed id for two genuinely different subjects (different prompts).
    Colliding ids must never both land in state.subjects — a later bootstrap
    would flap _plate_is_current between the two recipes and silently
    invalidate whichever subject's verdicts lost the coin flip."""
    import asyncio
    from matte_bench import web

    _client(tmp_path, monkeypatch)
    calls = {"n": 0}

    def fake_sample_subject(bucket, rng, templates):
        calls["n"] += 1
        prompt = "first prompt" if calls["n"] == 1 else "second prompt"
        return Subject(id="wispy-999", bucket=bucket, prompt=prompt,
                      seed=999, width=8, height=8)

    monkeypatch.setattr(web, "sample_subject", fake_sample_subject)
    first = asyncio.run(web._sample_fresh([], lambda *a, **k: None,
                                          rng=random.Random(1)))
    second = asyncio.run(web._sample_fresh([], lambda *a, **k: None,
                                           rng=random.Random(2)))
    assert first.id != second.id
    assert {s.id for s in web.state.subjects} == {first.id, second.id}


def test_techniques_route_includes_cls(client_with_state):
    client, _ = client_with_state
    body = client.get("/api/techniques").json()
    assert all(set(v) == {"label", "cls"} for v in body.values())
    assert body["a1x"]["cls"] == "A"
    assert body["b1x"]["cls"] == "B"


def test_predicted_verdicts_adds_winner_agnostic_tie():
    from matte_bench.web import _predicted_verdicts
    served = {"subject": "s1", "bucket": "wispy", "left": "a1x",
              "right": "a2x", "cls": "A", "repeat_of": None}
    got = _predicted_verdicts([], served)
    [v] = got
    assert v.winner == "tie" and v.cls == "A"
    assert (v.left, v.right) == ("a1x", "a2x")
    assert v.plate_hash == "prediction"   # never collides with a real hash


def test_start_prefetch_is_single_flight(bench_state, monkeypatch):
    from matte_bench import web
    import threading

    started = []
    release = threading.Event()

    def slow_run(served):
        started.append(served)
        release.wait(timeout=5)

    monkeypatch.setattr(web, "_run_prefetch", slow_run)
    served = {"subject": "s1", "bucket": "wispy", "left": "a1x",
              "right": "a2x", "cls": "A", "repeat_of": None}
    web._start_prefetch(served)
    web._start_prefetch(served)     # second call must be a no-op
    release.set()
    web.state.prefetch.join(timeout=5)
    assert len(started) == 1


def test_prefetch_never_consumes_the_shared_rng(bench_state, monkeypatch):
    """The spec's on/off equivalence guarantee at its mechanism: prediction
    clones the rng stream, so real picks are identical with prefetch on.

    Reuse-the-active-subject path: subjects must actually contain "s1" (a
    vacuous version of this test let the else-branch subject lookup return
    None and short-circuit before the rng clone ever ran) so _choose_comparison
    and _prepare genuinely execute against the shared rng."""
    import asyncio
    from matte_bench import web

    async def no_prepare(c, progress):
        pass

    monkeypatch.setattr(web, "_prepare", no_prepare)
    web.state.subjects = [Subject(id="s1", bucket="wispy", prompt="p", seed=1,
                                  width=64, height=64)]
    web.state.active_subject_id = "s1"
    web.state.active_served = 0
    before = web.state.rng.getstate()
    asyncio.run(web._prefetch_async({"subject": "s1", "bucket": "wispy",
                                     "left": "a1x", "right": "a2x",
                                     "cls": "A", "repeat_of": None}))
    assert web.state.rng.getstate() == before


def test_prefetch_staging_never_touches_rng_then_advances_it_on_consumption(
        bench_state, monkeypatch):
    """Staging branch (the one vacuous-test #1 above never exercised):
    _sample_fresh draws a bucket/template/LLM roll, all of which must come
    from a clone, not state.rng. The shared stream only advances later, when
    _pick_subject consumes the staged (subject, rng-state) pair — and it must
    land exactly where the clone did, so a real draw at that point is
    identical to what the prefetcher predicted."""
    import asyncio
    from matte_bench import web

    async def no_prepare(c, progress):
        pass

    monkeypatch.setattr(web, "_prepare", no_prepare)
    web.state.active_subject_id = None      # forces the staging branch
    web.state.staged = []
    before = web.state.rng.getstate()

    asyncio.run(web._prefetch_async({"subject": "s1", "bucket": "wispy",
                                     "left": "a1x", "right": "a2x",
                                     "cls": "A", "repeat_of": None}))

    # Staging happened, but the shared rng was not touched by it.
    assert web.state.rng.getstate() == before
    assert len(web.state.staged) == 1
    entry = web.state.staged[0]
    staged = entry.subject
    staged_rng_state = entry.consume_rng_state
    assert staged_rng_state is not None
    assert staged_rng_state != before   # the clone actually advanced

    # Consuming the staged subject is where the shared stream catches up.
    got = asyncio.run(web._pick_subject([], lambda *a, **k: None))
    assert got is staged
    assert web.state.rng.getstate() == staged_rng_state
    assert web.state.staged == []


def test_prefetch_stages_only_at_the_rotation_boundary(bench_state, monkeypatch):
    """active_served was already incremented by _compute_next for the served
    comparison, so the NEXT demand pick rotates once active_served reaches
    PAIRS_PER_SUBJECT, not PAIRS_PER_SUBJECT - 1. One shy of the boundary the
    prefetcher must reuse the active subject (no staging); at the boundary it
    must predict rotation and stage a fresh one."""
    import asyncio
    from matte_bench import web

    async def no_prepare(c, progress):
        pass

    monkeypatch.setattr(web, "_prepare", no_prepare)
    web.state.subjects = [Subject(id="s1", bucket="wispy", prompt="p", seed=1,
                                  width=64, height=64)]
    served = {"subject": "s1", "bucket": "wispy", "left": "a1x",
              "right": "a2x", "cls": "A", "repeat_of": None}

    web.state.active_subject_id = "s1"
    web.state.active_served = web.PAIRS_PER_SUBJECT - 1
    web.state.staged = []
    asyncio.run(web._prefetch_async(served))
    assert web.state.staged == []

    web.state.active_subject_id = "s1"
    web.state.active_served = web.PAIRS_PER_SUBJECT
    web.state.staged = []
    asyncio.run(web._prefetch_async(served))
    assert web.state.staged != []


def test_compute_next_joins_a_live_prefetch_before_preparing(tmp_path, monkeypatch):
    """The deterministic failure this guards against: comparison N is served,
    the prefetcher starts writing plate/render files for the staged subject
    in the background, and the operator votes before it finishes. Without
    synchronization the demand path's own ensure_plate/ensure_render would
    see stale dest.exists()/_plate_is_current checks, kick off a SECOND
    generation, and the plate write would rmtree the renders the prefetch
    just produced. Pinned at the guard's mechanism (a blocking join on a
    live prefetch thread before _prepare runs) rather than through the real
    filesystem race, which isn't reproducible deterministically in a unit
    test: real threads, not asyncio, drive both sides so the join provably
    blocks the demand path rather than the two coroutines merely interleaving
    within one event loop."""
    import asyncio
    import threading

    order = []
    release = threading.Event()

    def fake_prefetch_body():
        release.wait(timeout=5)
        order.append("prefetch-done")

    async def tracking_prepare(c, progress):
        order.append("prepare")

    _client(tmp_path, monkeypatch)
    monkeypatch.setattr(web, "_prepare", tracking_prepare)

    t = threading.Thread(target=fake_prefetch_body, daemon=True)
    web.state.prefetch = t
    t.start()

    # A separate real thread (not asyncio) releases the fake prefetch shortly
    # after _compute_next starts, proving _compute_next actually blocked on
    # the join instead of racing ahead into _prepare.
    threading.Timer(0.05, release.set).start()

    asyncio.run(web._compute_next(lambda *a, **k: None))
    assert order == ["prefetch-done", "prepare"]


def _staged_entry(subject, generation, rng_seed=99):
    """A StagedEntry the way the worker would build one: consume state is a
    clone advanced past the sampling draws."""
    clone = random.Random(rng_seed)
    return web.StagedEntry(subject=subject, consume_rng_state=clone.getstate(),
                           chain_rng_state=clone.getstate(),
                           predicted_pair=("a", "b"), generation=generation)


def test_rotation_consumes_staged_queue_head(tmp_path, monkeypatch):
    """A staged prediction for the current generation is consumed verbatim:
    no fresh sample, rng fast-forwarded to the staged state."""
    _client(tmp_path)
    staged_subject = Subject(id="wispy-777", bucket="wispy", prompt="a tuft",
                             seed=777, width=8, height=8)
    state.subjects.append(staged_subject)
    state.staged = [_staged_entry(staged_subject, generation=state.generation)]
    state.active_subject_id = None    # forces rotation

    async def fail_sample(*a, **k):
        raise AssertionError("consumption must not draw a fresh subject")

    monkeypatch.setattr(web, "_sample_fresh", fail_sample)
    subject = asyncio.run(web._pick_subject([], lambda *a, **k: None))
    assert subject.id == "wispy-777"
    assert state.staged == []
    assert state.active_subject_id == "wispy-777"


def test_two_rotations_consume_entries_in_order(tmp_path, monkeypatch):
    _client(tmp_path)
    s1 = Subject(id="wispy-1", bucket="wispy", prompt="p1", seed=1, width=8, height=8)
    s2 = Subject(id="wispy-2", bucket="wispy", prompt="p2", seed=2, width=8, height=8)
    state.subjects += [s1, s2]
    g = state.generation
    state.staged = [_staged_entry(s1, generation=g),
                    _staged_entry(s2, generation=g + 1)]
    state.active_subject_id = None

    async def fail_sample(*a, **k):
        raise AssertionError("no fresh draws while the queue holds valid entries")

    monkeypatch.setattr(web, "_sample_fresh", fail_sample)
    first = asyncio.run(web._pick_subject([], lambda *a, **k: None))
    state.active_subject_id = None    # force the next rotation immediately
    second = asyncio.run(web._pick_subject([], lambda *a, **k: None))
    assert [first.id, second.id] == ["wispy-1", "wispy-2"]
    assert state.staged == []


def test_stale_queue_is_cleared_whole(tmp_path, monkeypatch):
    """One stale head invalidates the entire lineage — entry 2 chained its
    rng and verdict predictions off entry 1, so it cannot survive alone."""
    _client(tmp_path)
    s1 = Subject(id="wispy-1", bucket="wispy", prompt="p1", seed=1, width=8, height=8)
    s2 = Subject(id="wispy-2", bucket="wispy", prompt="p2", seed=2, width=8, height=8)
    state.subjects += [s1, s2]
    state.staged = [_staged_entry(s1, generation=state.generation + 5),
                    _staged_entry(s2, generation=state.generation + 6)]
    state.active_subject_id = None
    sampled = Subject(id="wispy-fresh", bucket="wispy", prompt="f", seed=9,
                      width=8, height=8)

    async def fake_sample(*a, **k):
        return sampled

    monkeypatch.setattr(web, "_sample_fresh", fake_sample)
    subject = asyncio.run(web._pick_subject([], lambda *a, **k: None))
    assert subject.id == "wispy-fresh"
    assert state.staged == []


def test_pick_subject_consumes_staged_subject(bench_state):
    import asyncio
    from matte_bench import web
    staged = Subject(id="staged-1", bucket="wispy", prompt="p", seed=9,
                     width=64, height=64)
    # A freshly staged entry is stamped with the generation the prefetcher
    # observed when it staged; matching state.generation here is what marks
    # it fresh (see test_pick_subject_drops_a_stale_staged_subject for the
    # mismatch case).
    web.state.staged = [_staged_entry(staged, generation=web.state.generation)]
    web.state.active_subject_id = None   # forces rotation
    got = asyncio.run(web._pick_subject([], lambda *a, **k: None))
    assert got.id == "staged-1"
    assert web.state.staged == []
    assert web.state.active_subject_id == "staged-1"


def test_pick_subject_drops_a_stale_staged_subject(bench_state):
    """Task-13 review Finding 2 residual: a staged pair can go stale before
    it's consumed. Concrete race: the prefetch thread hasn't finished writing
    the staged queue when the next rotation happens, so _pick_subject takes
    the _sample_fresh fallback and rotates on its own (bumping
    state.generation); when the prefetch's StagedEntry eventually lands, it's
    a prediction for a rotation that already happened. Consuming it on some
    LATER rotation would setstate() the shared rng backward past every draw
    the intervening round(s) already made — replaying already-used
    randomness. The generation stamp must catch this: a staged entry whose
    generation no longer matches state.generation is dropped, not consumed,
    and state.rng is left alone."""
    import asyncio
    from matte_bench import web

    web.state.active_subject_id = None
    web.state.staged = []

    # Round 1: nothing staged yet -> fallback rotation. Bumps state.generation
    # 0 -> 1 and advances state.rng for real.
    first = asyncio.run(web._pick_subject([], lambda *a, **k: None))
    assert web.state.generation == 1
    rng_after_first_rotation = web.state.rng.getstate()

    # The prefetch thread now (late) finishes writing its prediction — staged
    # while generation was still 0, before the fallback rotation above ran.
    stale = Subject(id="stale-staged", bucket="wispy", prompt="p", seed=9,
                    width=64, height=64)
    stale_rng_state = random.Random(999).getstate()   # any state != current
    web.state.staged = [web.StagedEntry(
        subject=stale, consume_rng_state=stale_rng_state,
        chain_rng_state=stale_rng_state, predicted_pair=("a", "b"),
        generation=0)]   # stamped for the generation that ended

    # Force a second rotation (simulating PAIRS_PER_SUBJECT exhausted on the
    # subject the fallback picked) and confirm the stale entry is dropped,
    # not consumed: a fresh subject is drawn instead (advancing state.rng
    # further forward from where the first rotation left it), and state.rng
    # is never rewound to stale_rng_state.
    web.state.active_served = web.PAIRS_PER_SUBJECT
    second = asyncio.run(web._pick_subject([], lambda *a, **k: None))
    assert second.id != "stale-staged"
    assert second.id != first.id
    assert web.state.rng.getstate() != stale_rng_state
    assert web.state.rng.getstate() != rng_after_first_rotation
    assert web.state.staged == []


def test_original_route_serves_pre_key_image(tmp_path):
    client = _client(tmp_path)
    d = tmp_path / "renders" / "s1"
    d.mkdir(parents=True)
    (d / "abc123.orig.png").write_bytes(b"\x89PNG\r\n\x1a\nfake")
    resp = client.get("/original/s1/abc123.png")
    assert resp.status_code == 200
    assert resp.content.startswith(b"\x89PNG")


def test_original_route_404_when_absent(tmp_path):
    client = _client(tmp_path)
    (tmp_path / "renders" / "s1").mkdir(parents=True)
    assert client.get("/original/s1/abc123.png").status_code == 404


def test_original_route_rejects_traversal(tmp_path):
    client = _client(tmp_path)
    (tmp_path / "renders").mkdir(parents=True)
    secret = tmp_path / "secret.orig.png"
    secret.write_bytes(b"\x89PNG top secret")
    resp = client.get("/original/%2e%2e/secret.png")
    assert resp.status_code == 404


def test_outage_reads_as_error_and_drops_nothing(tmp_path, monkeypatch):
    """A ComfyUI outage must NOT read as 'session done'. This drives the
    GENERIC `except Exception` branch in `_compute_next` (a bare RuntimeError
    out of `_prepare`, not a RenderError) — the branch that would otherwise
    write `state.unavailable[c.left]` and report done. See
    test_render_error_outage_does_not_drop_the_technique below for the
    RenderError branch, which is the one that actually drops a technique."""
    client = _client(tmp_path)

    async def down_prepare(c, progress):
        raise RuntimeError("timed out during opening handshake")

    monkeypatch.setattr(web, "_prepare", down_prepare)
    state.comfy_probe = lambda url: "timed out during opening handshake"
    deadline = time.time() + 5.0
    while time.time() < deadline:
        resp = client.get("/api/next")
        if resp.status_code == 500:
            break
        assert resp.json()["status"] == "pending", resp.json()
        time.sleep(0.01)
    assert resp.status_code == 500
    detail = resp.json()["detail"]
    assert detail == ("ComfyUI unreachable at http://unused: "
                      "timed out during opening handshake")
    assert state.techniques == ["a", "b"]
    assert state.unavailable == {}


def test_render_error_outage_does_not_drop_the_technique(tmp_path, monkeypatch):
    """The RenderError branch is the only place `_compute_next` actually
    retires a technique from `state.techniques` (observed live 2026-08-07:
    chroma-magenta was dropped by a websocket handshake timeout, when the
    true cause was ComfyUI being unreachable, not a broken technique). When
    the box is ALSO unreachable, the outage must win: report 500, and leave
    the technique pool and `state.unavailable` untouched."""
    from matte_bench.render import RenderError

    client = _client(tmp_path)

    async def down_prepare(c, progress):
        raise RenderError("birefnet-hr", "timed out during opening handshake")

    monkeypatch.setattr(web, "_prepare", down_prepare)
    state.comfy_probe = lambda url: "timed out during opening handshake"
    deadline = time.time() + 5.0
    while time.time() < deadline:
        resp = client.get("/api/next")
        if resp.status_code == 500:
            break
        assert resp.json()["status"] == "pending", resp.json()
        time.sleep(0.01)
    assert resp.status_code == 500
    detail = resp.json()["detail"]
    assert detail == ("ComfyUI unreachable at http://unused: "
                      "timed out during opening handshake")
    assert state.techniques == ["a", "b"]
    assert state.unavailable == {}


def test_done_while_comfy_down_reads_as_error(tmp_path, monkeypatch):
    """With no comparison choosable (pool of one) the session would report
    done; when the box is ALSO unreachable, the outage is the truer story —
    this is what an operator sees when the bench booted while the box was
    off."""
    client = _client(tmp_path, monkeypatch)
    state.techniques = ["a"]
    state.technique_cls = {"a": "A"}
    state.comfy_probe = lambda url: "connect timeout"
    deadline = time.time() + 5.0
    while time.time() < deadline:
        resp = client.get("/api/next")
        if resp.status_code == 500:
            break
        assert resp.json()["status"] in ("pending", "done"), resp.json()
        time.sleep(0.01)
    assert resp.status_code == 500
    assert resp.json()["detail"] == "ComfyUI unreachable at http://unused: connect timeout"

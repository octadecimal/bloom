"""Routes and the judging page.

Thin by design: the logic lives in pairing/ranking/postops, which are pure and
unit-tested. This module wires them to HTTP and serves one static page.
"""
import asyncio
import random
import threading
import time
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, field_validator

from matte_bench.corpus import (
    BUCKETS, Subject, append_subject, ensure_plate, plate_hash, plate_path,
)
from matte_bench.pairing import (
    Comparison, least_judged_bucket, next_sampled_comparison, pick_class,
)
from matte_bench.playoff import derive_cls, playoff_pair
from matte_bench.probe import comfy_unreachable
from matte_bench.promptgen import sample_subject_llm
from matte_bench.progress import progress
from matte_bench.ranking import separated, standings
from matte_bench.render import RenderError, ensure_render
from matte_bench.sampler import sample_subject
from matte_bench.store import (
    Fault, Verdict, append_fault, append_verdict, fresh_verdicts, read_verdicts,
)

STATIC = Path(__file__).parent / "static"

# Anchored to the module's own location, not cwd: the justfile recipe runs
# this app with cwd studio/backend, so a cwd-relative default would strand
# every verdict under studio/backend/tools/matte-bench instead of the
# committed path the rest of the data model depends on.
_BENCH_DIR = Path(__file__).resolve().parents[1]   # tools/matte-bench
_REPO_ROOT = _BENCH_DIR.parents[1]                 # repo root


PREFETCH_DEPTH = 2


@dataclass
class StagedEntry:
    """One fully-rendered future subject in the prefetch pipeline. v2: a
    rendered subject is ALWAYS valid — there is no lineage bookkeeping and no
    staleness. The pair is kept only so later worker runs can fold this
    entry's predicted serves in as synthetic ties before predicting the
    entries after it."""
    subject: Subject
    predicted_pair: tuple[str, str]


@dataclass
class State:
    root: Path = field(default_factory=lambda: _REPO_ROOT / "var" / "matte-bench")
    subjects: list[Subject] = field(default_factory=list)
    techniques: list[str] = field(default_factory=list)
    technique_names: dict[str, str] = field(default_factory=dict)
    technique_objs: dict = field(default_factory=dict)
    technique_cls: dict[str, str] = field(default_factory=dict)
    comfy_url: str = ""
    # Injected so tests control reachability; production uses the real probe.
    comfy_probe: object = comfy_unreachable
    unavailable: dict[str, str] = field(default_factory=dict)
    verdict_log: Path = field(default_factory=lambda: _BENCH_DIR / "verdicts.jsonl")
    fault_log: Path = field(default_factory=lambda: _BENCH_DIR / "faults.jsonl")
    subject_log: Path = field(
        default_factory=lambda: _BENCH_DIR / "subjects-sampled.jsonl")
    templates: dict = field(default_factory=dict)
    llm: object | None = None      # LLMProvider; None disables LLM sampling
    llm_model: str = ""
    active_subject_id: str | None = None
    active_served: int = 0
    plate_hashes: dict[str, str] = field(default_factory=dict)
    rng: random.Random = field(default_factory=lambda: random.Random())
    job: "_NextJob | None" = None
    job_lock: threading.Lock = field(default_factory=threading.Lock)
    # A FIFO of fully-rendered future subjects. Consumption pops the head
    # unconditionally — entries never go stale (see StagedEntry). Guarded by
    # staged_cond: pops and the consume-or-wait in _pick_subject, appends in
    # the worker's fill loop (which notify), all in short synchronous
    # sections, never held across an `await`.
    staged: list = field(default_factory=list)
    staged_cond: threading.Condition = field(default_factory=threading.Condition)
    # The worker's private, persistent rng stream (lazily cloned from
    # state.rng on its first run, then never reset). The demand stream and
    # this one are independent by design: v1 tried to keep them in lockstep
    # via per-entry rng snapshots and generation stamps, which meant one
    # fallback rotation permanently staled the whole queue and the worker's
    # GPU output was discarded forever (measured live 2026-08-07). Divergence
    # costs at most a render-cache miss on a pair choice.
    prefetch_rng: "random.Random | None" = None
    prefetch: threading.Thread | None = None
    prefetch_lock: threading.Lock = field(default_factory=threading.Lock)
    # Subject ids the prefetch worker is currently preparing (plate/render
    # writes in flight). Guards against the demand path racing the exact
    # same subject's files, without blocking on subjects the worker isn't
    # touching — see _await_subject_free / _guarded_prepare.
    rendering: set = field(default_factory=set)
    render_cond: threading.Condition = field(default_factory=threading.Condition)


state = State()
app = FastAPI(title="matte-bench")


@app.middleware("http")
async def _no_store(request: Request, call_next):
    """A stale index.html means the operator runs last session's JS without
    knowing it, and every /api payload is live state — neither may be cached.
    Renders and plates stay cacheable; they are immutable once written."""
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


class VerdictIn(BaseModel):
    subject: str
    bucket: str
    left: str
    right: str
    winner: str
    repeat_of: str | None = None

    @field_validator("winner")
    @classmethod
    def _known(cls, v: str) -> str:
        if v not in ("left", "right", "tie", "both_bad"):
            raise ValueError("winner must be left, right, tie or both_bad")
        return v


class FaultIn(BaseModel):
    subject: str
    technique: str
    tags: list[str]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _live_verdicts() -> list[Verdict]:
    return fresh_verdicts(read_verdicts(state.verdict_log), state.plate_hashes)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


async def _prepare(comparison, progress) -> None:
    """Render the two images this comparison needs, generating the subject's
    plate first if this is its first appearance.

    Rendering lazily is the point: pre-rendering the whole matrix meant a
    30-60 minute wait before the operator could judge anything. Everything is
    cached, so each image is produced at most once.

    `progress(text, percent, stage)` messages are shown to the judge
    mid-comparison, so the text must stay blind: name the subject if useful,
    never a technique. stage "render-1" always means the LEFT side and
    "render-2" the RIGHT, so the page can put the bar over the right panel.
    """
    subject = next(s for s in state.subjects if s.id == comparison.subject)
    plate_text = (f"generating source image for {subject.id}… "
                  "(first visit to a subject; can take a minute or two)")
    if not plate_path(state.root, subject.id).exists():
        progress(plate_text, None, "plate")
    await ensure_plate(subject, state.root, state.comfy_url,
                       on_progress=lambda f: progress(plate_text, f, "plate"))
    # plate_hashes was computed at bootstrap, before this plate existed; keep
    # it current or /api/verdict 404s and the vote is lost. Recomputed rather
    # than filled-if-missing so a mid-session regeneration also lands.
    state.plate_hashes[subject.id] = plate_hash(
        plate_path(state.root, subject.id).read_bytes())
    sides = [("render-1", state.technique_objs.get(comparison.left)),
             ("render-2", state.technique_objs.get(comparison.right))]
    todo = [(stage, t) for stage, t in sides if t is not None]
    for i, (stage, technique) in enumerate(todo, start=1):
        text = f"rendering candidate {i} of {len(todo)}…"
        progress(text, None, stage)
        await ensure_render(
            subject, technique, state.root, state.comfy_url,
            on_progress=lambda f, text=text, stage=stage: progress(text, f, stage))


def _await_subject_free(subject_id: str, timeout: float = 300.0) -> None:
    """Block while the prefetch worker is preparing this exact subject —
    writing the same plate/renders from two threads races rmtree against
    fresh files. Bounded: on timeout the caller proceeds and worst-case pays
    a duplicate render (the pre-pipeline behavior), never a wedge."""
    deadline = time.monotonic() + timeout
    with state.render_cond:
        while subject_id in state.rendering:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            state.render_cond.wait(remaining)


async def _guarded_prepare(c, progress) -> None:
    """The worker's _prepare wrapper: registers the subject as in-flight so
    the demand path can wait for exactly this subject and nothing else."""
    with state.render_cond:
        state.rendering.add(c.subject)
    try:
        await _prepare(c, progress)
    finally:
        with state.render_cond:
            state.rendering.discard(c.subject)
            state.render_cond.notify_all()


# How many comparisons each sampled subject serves before a fresh one is
# drawn. 1 would be maximally random but pays a full plate generation per
# verdict; a small number amortizes the wait while the corpus stays sampled.
PAIRS_PER_SUBJECT = 3


# Fraction of fresh draws that use the template sampler even when the LLM is
# available: keeps the reels-frame template and the tested-known distribution
# in rotation alongside open-ended LLM inventions.
TEMPLATE_MIX = 0.25


async def _sample_fresh(verdicts, progress, rng: random.Random | None = None) -> Subject:
    """Draw and register a fresh subject from the thinnest bucket. LLM-imagined
    when a provider is configured, template-sampled otherwise.

    `rng` defaults to the shared state.rng for the demand path. The
    prefetcher passes a clone instead, so its staging draw never advances the
    shared stream directly (see _prefetch_async)."""
    if rng is None:
        rng = state.rng
    buckets = [b for b in BUCKETS if b in state.templates]
    bucket = least_judged_bucket(buckets, verdicts, rng)
    subject = None
    if state.llm is not None and rng.random() >= TEMPLATE_MIX:
        progress("imagining a new subject…")
        recent = [s.prompt.split(",")[0] for s in state.subjects
                  if s.bucket == bucket][-6:]
        subject = await sample_subject_llm(bucket, rng, state.templates,
                                           state.llm, state.llm_model, recent)
    if subject is None:
        subject = sample_subject(bucket, rng, state.templates)
    existing_ids = {s.id for s in state.subjects}
    while subject.id in existing_ids:
        # Collision: the demand path's fallback draw and the prefetcher's
        # rng clone can independently mint the same bucket-seed id for two
        # DIFFERENT subjects (their prompts diverge on the LLM path even
        # when the seed matches). Two log entries sharing an id makes
        # _plate_is_current flap between the two recipes on later
        # bootstraps, silently invalidating whichever subject's verdicts
        # lose the race — so redraw the seed (bucket/prompt stay put) until
        # the id is unique, rather than let it collide.
        seed = rng.randrange(1, 2**31)
        subject = replace(subject, id=f"{bucket}-{seed}", seed=seed)
    append_subject(state.subject_log, subject)
    state.subjects.append(subject)
    return subject


def _pop_staged_or_wait(progress, timeout: float = 300.0):
    """The staged head, waiting for the worker to produce one if it must.

    v1 sampled a fresh subject the moment the queue was empty — which
    launched a demand render that CONTENDED with the worker's speculative
    renders on the serial GPU, stretching both (measured live: waits got
    worse, not better). v2 waits: if the worker is alive it is already
    rendering the very subject this rotation needs, and consuming it the
    moment it lands is strictly faster than starting a rival. Falls back to
    None (caller samples fresh) only when there is no worker to wait for or
    the bounded wait expires — never a wedge."""
    deadline = time.monotonic() + timeout
    with state.staged_cond:
        while True:
            if state.staged:
                return state.staged.pop(0)
            worker = state.prefetch
            if worker is None or not worker.is_alive():
                return None
            progress("waiting for pre-generated subject…")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            # Short slices so a worker death is noticed promptly even
            # without a notify.
            state.staged_cond.wait(min(remaining, 1.0))


async def _pick_subject(verdicts, progress) -> Subject:
    """Reuse the active sampled subject for a few comparisons (its plate is
    cached), then rotate to the next pre-rendered subject from the pipeline —
    waiting for the worker when the queue is momentarily empty rather than
    racing it to the GPU. A fresh demand draw is the last resort (no worker
    alive, or the wait timed out). The shared rng is never touched by
    consumption; the worker predicts on its own private stream
    (state.prefetch_rng) and divergence between the two is acceptable by
    design."""
    if state.active_subject_id is not None and state.active_served < PAIRS_PER_SUBJECT:
        active = next((s for s in state.subjects
                       if s.id == state.active_subject_id), None)
        if active is not None:
            return active
    entry = _pop_staged_or_wait(progress)
    if entry is not None:
        subject = entry.subject
        print(f"prefetch hit: {subject.id}")
    else:
        print("prefetch miss (no pipeline output)")
        subject = await _sample_fresh(verdicts, progress)
    state.active_subject_id = subject.id
    state.active_served = 0
    return subject


def _pools() -> dict[str, list[str]]:
    pools: dict[str, list[str]] = {"A": [], "B": []}
    for h in state.techniques:
        pools.setdefault(state.technique_cls.get(h, "A"), []).append(h)
    return pools


def _choose_comparison(subject, verdicts, rng):
    """The comparison to serve on this subject, and its class. The playoff
    pair bypasses the sampled picker: its two contenders are fixed."""
    pools = _pools()
    pair = playoff_pair(verdicts, subject.bucket)
    # playoff_pair derives champions from the verdict LOG alone, which can
    # name a technique that has since been dropped from the live registry
    # (the RenderError path removes a hash from state.techniques but leaves
    # its past verdicts logged). Trust the pair only when both champions are
    # still servable — otherwise api_verdict's derive_cls would 422 every
    # vote on it forever, and since X never accumulates it stays the
    # thinnest class, wedging this bucket on a comparison that can never be
    # judged.
    playoff_open = pair is not None and all(h in state.techniques for h in pair)
    cls = pick_class(subject.bucket, verdicts, pools, playoff_open)
    if cls is None:
        return None, None
    if cls == "X":
        a, b = pair
        left, right = (a, b) if rng.random() < 0.5 else (b, a)
        return Comparison(subject=subject.id, bucket=subject.bucket,
                          left=left, right=right), "X"
    c = next_sampled_comparison(subject, pools[cls], verdicts, rng,
                                cls=cls, known=state.subjects)
    return c, cls


def _raise_if_comfy_down() -> None:
    """An infra outage must read as an outage — not as 'session done' and not
    as a broken technique. Probe before blaming either."""
    reason = state.comfy_probe(state.comfy_url)
    if reason is not None:
        raise RuntimeError(f"ComfyUI unreachable at {state.comfy_url}: {reason}")


async def _compute_next(progress):
    for _ in range(8):
        progress("choosing comparison…")
        verdicts = _live_verdicts()
        subject = await _pick_subject(verdicts, progress)
        c, cls = _choose_comparison(subject, verdicts, state.rng)
        if c is None:
            _raise_if_comfy_down()
            return None
        _await_subject_free(c.subject)
        try:
            await _prepare(c, progress)
        except RenderError as exc:
            _raise_if_comfy_down()
            # Discovered lazily rather than by a pre-flight sweep: drop it and
            # move on, but never silently — the operator must be able to see
            # that they are judging fewer techniques than they think.
            state.unavailable[exc.technique_id] = exc.reason
            state.techniques = [t for t in state.techniques
                                if state.technique_objs.get(t) is None
                                or state.technique_objs[t].id != exc.technique_id]
            continue
        except Exception as exc:                  # noqa: BLE001 - reported, not swallowed
            _raise_if_comfy_down()
            state.unavailable[c.left] = str(exc)
            return None
        if c.repeat_of is None and c.subject == state.active_subject_id:
            state.active_served += 1
        return {"subject": c.subject, "bucket": c.bucket, "left": c.left,
                "right": c.right, "repeat_of": c.repeat_of, "cls": cls}
    _raise_if_comfy_down()
    return None


class _NextJob:
    """Runs _compute_next in a worker thread with its own event loop.

    Preparing a comparison takes 30s-2min against ComfyUI, and parts of the
    path (plate upload) block outright — on the server's own event loop that
    froze every other route, and a blocking /api/next left the page with no
    way to show what was happening. Off-loop, /api/next answers instantly.
    """

    def __init__(self):
        self.progress = "choosing comparison…"
        self.percent: float | None = None
        self.stage: str | None = None
        self.result = None
        self.error: str | None = None
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def join(self, timeout: float) -> None:
        self._thread.join(timeout)

    @property
    def finished(self) -> bool:
        return not self._thread.is_alive()

    def _run(self) -> None:
        try:
            self.result = asyncio.run(_compute_next(self._set_progress))
        except Exception as exc:                  # noqa: BLE001 - reported, not swallowed
            self.error = str(exc)

    def _set_progress(self, text: str, percent: float | None = None,
                      stage: str | None = None) -> None:
        self.progress = text
        self.percent = percent
        self.stage = stage


def _predicted_verdicts(verdicts: list[Verdict], served: dict) -> list[Verdict]:
    """The verdict set after the operator votes on `served`, winner-agnostic:
    a synthetic tie moves every pair count exactly like a real verdict, and
    the winner only nudges the strength tie-break."""
    return verdicts + [Verdict(
        subject=served["subject"], bucket=served["bucket"],
        left=served["left"], right=served["right"], winner="tie",
        plate_hash="prediction", ts="", cls=served.get("cls", "A"))]


def _synthetic_ties(verdicts, subject_id, bucket, pair, count, cls="A"):
    """Ties the operator hasn't cast yet, for prediction only: each moves the
    pair counts exactly like a real verdict without picking a winner. Used to
    fold serves that HAVEN'T happened yet (the active subject's remaining
    pairs, every already-staged entry's future serves) into the verdict set
    the queue-filling loop predicts against, so its bucket/class choices
    reflect where the bench will actually be once those serves land."""
    left, right = pair
    return verdicts + [Verdict(subject=subject_id, bucket=bucket, left=left,
                               right=right, winner="tie",
                               plate_hash="prediction", ts="", cls=cls)
                       for _ in range(count)]


def _cloned_rng(source: random.Random) -> random.Random:
    """A fresh Random seeded to `source`'s exact state, so advancing the
    clone never advances `source` itself."""
    clone = random.Random()
    clone.setstate(source.getstate())
    return clone


async def _prefetch_async(served: dict) -> None:
    """Runs after every serve, in the background: tops state.staged up to
    PREFETCH_DEPTH so the GPU is always working a subject or two ahead of
    what the operator is currently judging, starting the moment a subject
    begins serving.

    All prediction draws run on state.prefetch_rng — the worker's private,
    persistent stream (lazily cloned from state.rng once, never reset).
    v1 chained per-entry rng snapshots and generation stamps so the demand
    stream could be fast-forwarded to match; live testing showed that
    machinery discarding every entry the moment one fallback rotation
    happened. v2 accepts stream divergence: subjects are consumed from the
    queue, never re-derived, so divergence costs at most a render-cache miss
    on a pair choice (Class B: impossible with two techniques; Class A:
    seconds). The throwaway clone below answers only "what will the active
    subject serve next" and is never stored."""
    verdicts = _predicted_verdicts(_live_verdicts(), served)
    noop = lambda *a, **k: None                       # noqa: E731

    # 1. The active subject's own next pair (usually a cache hit) keeps
    # intra-subject serves instant.
    active = next((s for s in state.subjects
                   if s.id == state.active_subject_id), None)
    if active is not None and state.active_served < PAIRS_PER_SUBJECT:
        c, _cls = _choose_comparison(active, verdicts, _cloned_rng(state.rng))
        if c is not None:
            await _guarded_prepare(c, noop)

    # 2. Account for the serves that will happen before the first rotation:
    # the active subject's remaining pairs vote as synthetic ties.
    if active is not None:
        remaining = max(0, PAIRS_PER_SUBJECT - state.active_served)
        verdicts = _synthetic_ties(verdicts, active.id, active.bucket,
                                   (served["left"], served["right"]),
                                   remaining, served.get("cls", "A"))

    # 3. Fold in the predicted serves of everything already staged, so the
    # bucket-balance and pair-count predictions for NEW entries assume the
    # queue ahead of them gets judged first. Snapshot under the condition:
    # the demand thread pops concurrently.
    if state.prefetch_rng is None:
        state.prefetch_rng = _cloned_rng(state.rng)
    pred_rng = state.prefetch_rng
    with state.staged_cond:
        staged_snapshot = list(state.staged)
    for e in staged_snapshot:
        verdicts = _synthetic_ties(verdicts, e.subject.id, e.subject.bucket,
                                   e.predicted_pair, PAIRS_PER_SUBJECT)

    # 4. Fill to depth. Each iteration: sample a subject on the private
    # stream, choose its first comparison, render it fully, then stage it —
    # append-after-prepare, so the queue only ever holds served-ready
    # entries. The notify wakes a demand thread blocked in
    # _pop_staged_or_wait.
    while True:
        with state.staged_cond:
            if len(state.staged) >= PREFETCH_DEPTH:
                return
        subject = await _sample_fresh(verdicts, noop, rng=pred_rng)
        c, _cls = _choose_comparison(subject, verdicts, pred_rng)
        if c is None:
            return
        await _guarded_prepare(c, noop)
        with state.staged_cond:
            state.staged.append(StagedEntry(
                subject=subject, predicted_pair=(c.left, c.right)))
            state.staged_cond.notify_all()
        verdicts = _synthetic_ties(verdicts, subject.id, subject.bucket,
                                   (c.left, c.right), PAIRS_PER_SUBJECT)


def _run_prefetch(served: dict) -> None:
    try:
        asyncio.run(_prefetch_async(served))
    except Exception:                                 # noqa: BLE001
        # Prefetch is best-effort by contract: any failure here simply means
        # the demand path pays the render and reports errors properly.
        pass


def _start_prefetch(served: dict) -> None:
    with state.prefetch_lock:
        if state.prefetch is not None and state.prefetch.is_alive():
            return
        t = threading.Thread(target=_run_prefetch, args=(served,), daemon=True)
        state.prefetch = t
        t.start()


# A fully cached comparison resolves in milliseconds; waiting this long before
# answering saves the client a poll round-trip without a perceptible stall.
_NEXT_GRACE_SECONDS = 0.25


@app.get("/api/next")
def api_next() -> dict:
    """Job-style poll endpoint: {"status": "pending", "progress": …} while a
    comparison is being prepared, {"status": "ready", "comparison": …} once it
    is, {"status": "done"} when the session is exhausted. The client polls."""
    with state.job_lock:
        if state.job is None:
            state.job = _NextJob()
            state.job.start()
        job = state.job
    job.join(_NEXT_GRACE_SECONDS)
    if not job.finished:
        return {"status": "pending", "progress": job.progress,
                "percent": job.percent, "stage": job.stage}
    with state.job_lock:
        if state.job is job:
            state.job = None
    if job.error is not None:
        raise HTTPException(status_code=500, detail=job.error)
    if job.result is None:
        return {"status": "done"}
    _start_prefetch(job.result)
    return {"status": "ready", "comparison": job.result}


@app.get("/api/unavailable")
def api_unavailable() -> dict:
    """Techniques that failed to render, discovered as they were encountered."""
    return dict(state.unavailable)


@app.post("/api/verdict")
def api_verdict(body: VerdictIn) -> dict:
    plate_hash = state.plate_hashes.get(body.subject)
    if plate_hash is None:
        raise HTTPException(status_code=404, detail="unknown subject")
    verdicts = _live_verdicts()
    cls = derive_cls(body.left, body.right, state.technique_cls, verdicts,
                     body.bucket)
    if cls is None:
        raise HTTPException(status_code=422,
                            detail="pair is not a legal comparison")
    append_verdict(state.verdict_log, Verdict(
        subject=body.subject, bucket=body.bucket, left=body.left,
        right=body.right, winner=body.winner, plate_hash=plate_hash,
        ts=_now(), repeat_of=body.repeat_of, cls=cls))
    if body.winner == "both_bad":
        # Two facts in one keypress: no relative preference (the ranking
        # already weighs it as a tie) and an absolute failure of EACH side,
        # which belongs in the fault log.
        for technique in (body.left, body.right):
            append_fault(state.fault_log, Fault(
                subject=body.subject, technique=technique,
                tags=("both-bad",), ts=_now()))
    return {"ok": True}


@app.post("/api/fault")
def api_fault(body: FaultIn) -> dict:
    append_fault(state.fault_log, Fault(subject=body.subject,
                                        technique=body.technique,
                                        tags=tuple(body.tags), ts=_now()))
    return {"ok": True}


@app.get("/api/standings/{bucket}")
def api_standings(bucket: str, cls: str = "A") -> dict:
    if cls not in ("A", "B", "X"):
        raise HTTPException(status_code=422, detail="cls must be A, B or X")
    rows = standings(_live_verdicts(), bucket, cls=cls)
    return {
        "separated": separated(rows),
        "rows": [
            {"technique": r.technique,
             "label": state.technique_names.get(r.technique, r.technique),
             "score": r.score, "low": r.low, "high": r.high,
             "comparisons": r.comparisons}
            for r in rows
        ],
    }


@app.get("/api/progress")
def api_progress() -> dict:
    """Session progress per comparison class: how much has been judged and
    which buckets are settled. Winner names only for separated buckets — the
    judge stays blind to the standings of buckets still in play."""
    report = progress(_live_verdicts(), state.technique_names)
    return {
        "total": report.total,
        "classes": [
            {"cls": c.cls, "total": c.total,
             "buckets": [
                 {"bucket": b.bucket, "count": b.count,
                  "separated": b.separated, "winner": b.winner}
                 for b in c.buckets
             ]}
            for c in report.classes
        ],
    }


@app.get("/api/techniques")
def api_techniques() -> dict:
    """Hash -> {label, cls}. Standings are keyed by config hash; without this
    the leaderboard is unreadable, and cls tells the page which class table a
    technique belongs on."""
    return {h: {"label": state.technique_names.get(h, h),
                "cls": state.technique_cls.get(h, "A")}
            for h in state.techniques}


@app.get("/render/{subject}/{technique}.png")
def api_render(subject: str, technique: str) -> FileResponse:
    """Serve a cached render.

    The two path parameters are attacker-controlled and are used to build a
    filesystem path, so the resolved result must be confirmed to sit inside
    the renders directory. A bare ".." segment escapes it otherwise, and the
    service binds to 0.0.0.0.
    """
    root = (state.root / "renders").resolve()
    path = (root / subject / f"{technique}.png").resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise HTTPException(status_code=404, detail="render not found")
    return FileResponse(path, media_type="image/png")


@app.get("/original/{subject}/{technique}.png")
def api_original(subject: str, technique: str) -> FileResponse:
    """The pre-key generation a Class B backdrop render was keyed from.

    Same traversal rule as /render: both path parameters are
    attacker-controlled and the service binds to 0.0.0.0, so the resolved
    path must stay inside the renders directory."""
    root = (state.root / "renders").resolve()
    path = (root / subject / f"{technique}.orig.png").resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise HTTPException(status_code=404, detail="original not found")
    return FileResponse(path, media_type="image/png")


@app.get("/plate/{subject}.png")
def api_plate(subject: str) -> FileResponse:
    """The shared source image both sides of a comparison were cut from."""
    root = (state.root / "plates").resolve()
    path = (root / f"{subject}.png").resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise HTTPException(status_code=404, detail="plate not found")
    return FileResponse(path, media_type="image/png")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html", media_type="text/html")

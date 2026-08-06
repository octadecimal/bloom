"""Routes and the judging page.

Thin by design: the logic lives in pairing/ranking/postops, which are pure and
unit-tested. This module wires them to HTTP and serves one static page.
"""
import asyncio
import random
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, field_validator

from matte_bench.corpus import (
    BUCKETS, Subject, append_subject, ensure_plate, plate_hash, plate_path,
)
from matte_bench.pairing import least_judged_bucket, next_sampled_comparison
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


@dataclass
class State:
    root: Path = field(default_factory=lambda: _REPO_ROOT / "var" / "matte-bench")
    subjects: list[Subject] = field(default_factory=list)
    techniques: list[str] = field(default_factory=list)
    technique_names: dict[str, str] = field(default_factory=dict)
    technique_objs: dict = field(default_factory=dict)
    technique_cls: dict[str, str] = field(default_factory=dict)
    comfy_url: str = ""
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


# How many comparisons each sampled subject serves before a fresh one is
# drawn. 1 would be maximally random but pays a full plate generation per
# verdict; a small number amortizes the wait while the corpus stays sampled.
PAIRS_PER_SUBJECT = 3


# Fraction of fresh draws that use the template sampler even when the LLM is
# available: keeps the reels-frame template and the tested-known distribution
# in rotation alongside open-ended LLM inventions.
TEMPLATE_MIX = 0.25


async def _pick_subject(verdicts, progress) -> Subject:
    """Reuse the active sampled subject for a few comparisons (its plate is
    cached), then draw a fresh one from the thinnest bucket and register it.
    Fresh draws are LLM-imagined when a provider is configured, template-
    sampled otherwise or whenever the LLM output fails the isolation rules."""
    if state.active_subject_id is not None and state.active_served < PAIRS_PER_SUBJECT:
        active = next((s for s in state.subjects
                       if s.id == state.active_subject_id), None)
        if active is not None:
            return active
    buckets = [b for b in BUCKETS if b in state.templates]
    bucket = least_judged_bucket(buckets, verdicts, state.rng)
    subject = None
    if state.llm is not None and state.rng.random() >= TEMPLATE_MIX:
        progress("imagining a new subject…")
        recent = [s.prompt.split(",")[0] for s in state.subjects
                  if s.bucket == bucket][-6:]
        subject = await sample_subject_llm(bucket, state.rng, state.templates,
                                           state.llm, state.llm_model, recent)
    if subject is None:
        subject = sample_subject(bucket, state.rng, state.templates)
    append_subject(state.subject_log, subject)
    state.subjects.append(subject)
    state.active_subject_id = subject.id
    state.active_served = 0
    return subject


async def _compute_next(progress):
    for _ in range(8):
        progress("choosing comparison…")
        if len(state.techniques) < 2:
            return None
        verdicts = _live_verdicts()
        subject = await _pick_subject(verdicts, progress)
        c = next_sampled_comparison(subject, state.techniques, verdicts,
                                    state.rng, known=state.subjects)
        if c is None:
            return None
        try:
            await _prepare(c, progress)
        except RenderError as exc:
            # Discovered lazily rather than by a pre-flight sweep: drop it and
            # move on, but never silently — the operator must be able to see
            # that they are judging fewer techniques than they think.
            state.unavailable[exc.technique_id] = exc.reason
            state.techniques = [t for t in state.techniques
                                if state.technique_objs.get(t) is None
                                or state.technique_objs[t].id != exc.technique_id]
            continue
        except Exception as exc:                  # noqa: BLE001 - reported, not swallowed
            state.unavailable[c.left] = str(exc)
            return None
        if c.repeat_of is None and c.subject == state.active_subject_id:
            state.active_served += 1
        return {"subject": c.subject, "bucket": c.bucket, "left": c.left,
                "right": c.right, "repeat_of": c.repeat_of}
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
    append_verdict(state.verdict_log, Verdict(
        subject=body.subject, bucket=body.bucket, left=body.left,
        right=body.right, winner=body.winner, plate_hash=plate_hash,
        ts=_now(), repeat_of=body.repeat_of))
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
def api_standings(bucket: str) -> dict:
    rows = standings(_live_verdicts(), bucket)
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
    """Hash -> human name. Standings are keyed by config hash; without this the
    leaderboard is unreadable."""
    return dict(state.technique_names)


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

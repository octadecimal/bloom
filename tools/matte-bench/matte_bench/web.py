"""Routes and the judging page.

Thin by design: the logic lives in pairing/ranking/postops, which are pure and
unit-tested. This module wires them to HTTP and serves one static page.
"""
import random
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, field_validator

from matte_bench.corpus import Subject, ensure_plate
from matte_bench.pairing import next_comparison
from matte_bench.ranking import separated, standings
from matte_bench.render import RenderError, ensure_render
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
    comfy_url: str = ""
    unavailable: dict[str, str] = field(default_factory=dict)
    verdict_log: Path = field(default_factory=lambda: _BENCH_DIR / "verdicts.jsonl")
    fault_log: Path = field(default_factory=lambda: _BENCH_DIR / "faults.jsonl")
    plate_hashes: dict[str, str] = field(default_factory=dict)
    rng: random.Random = field(default_factory=lambda: random.Random())


state = State()
app = FastAPI(title="matte-bench")


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
        if v not in ("left", "right", "tie"):
            raise ValueError("winner must be left, right or tie")
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


async def _prepare(comparison) -> None:
    """Render the two images this comparison needs, generating the subject's
    plate first if this is its first appearance.

    Rendering lazily is the point: pre-rendering the whole matrix meant a
    30-60 minute wait before the operator could judge anything. Everything is
    cached, so each image is produced at most once.
    """
    subject = next(s for s in state.subjects if s.id == comparison.subject)
    await ensure_plate(subject, state.root, state.comfy_url)
    for handle in (comparison.left, comparison.right):
        technique = state.technique_objs.get(handle)
        if technique is not None:
            await ensure_render(subject, technique, state.root, state.comfy_url)


@app.get("/api/next")
async def api_next():
    for _ in range(8):
        c = next_comparison(state.subjects, state.techniques,
                            _live_verdicts(), state.rng)
        if c is None:
            return None
        try:
            await _prepare(c)
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
        return {"subject": c.subject, "bucket": c.bucket, "left": c.left,
                "right": c.right, "repeat_of": c.repeat_of}
    return None


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


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html", media_type="text/html")

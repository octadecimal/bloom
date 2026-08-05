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

from matte_bench.corpus import Subject
from matte_bench.pairing import next_comparison
from matte_bench.ranking import standings
from matte_bench.store import (
    Fault, Verdict, append_fault, append_verdict, fresh_verdicts, read_verdicts,
)

STATIC = Path(__file__).parent / "static"


@dataclass
class State:
    root: Path = Path("var/matte-bench")
    subjects: list[Subject] = field(default_factory=list)
    techniques: list[str] = field(default_factory=list)
    verdict_log: Path = Path("tools/matte-bench/verdicts.jsonl")
    fault_log: Path = Path("tools/matte-bench/faults.jsonl")
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


@app.get("/api/next")
def api_next():
    c = next_comparison(state.subjects, state.techniques, _live_verdicts(), state.rng)
    if c is None:
        return None
    return {"subject": c.subject, "bucket": c.bucket, "left": c.left,
            "right": c.right, "repeat_of": c.repeat_of}


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
def api_standings(bucket: str) -> list[dict]:
    rows = standings(_live_verdicts(), bucket)
    return [{"technique": r.technique, "score": r.score, "low": r.low,
             "high": r.high, "comparisons": r.comparisons} for r in rows]


@app.get("/render/{subject}/{technique}.png")
def api_render(subject: str, technique: str) -> FileResponse:
    path = state.root / "renders" / subject / f"{technique}.png"
    if not path.exists():
        raise HTTPException(status_code=404, detail="render not found")
    return FileResponse(path, media_type="image/png")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html", media_type="text/html")

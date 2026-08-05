"""Append-only verdict/fault logs plus atomic cache writes.

The leaderboard is never stored; it is recomputed from the verdict log, so
there is one source of truth and no cache to fall out of sync.
"""
import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass(frozen=True)
class Verdict:
    subject: str
    bucket: str
    left: str
    right: str
    winner: str          # "left" | "right" | "tie"
    plate_hash: str
    ts: str
    repeat_of: str | None = None


@dataclass(frozen=True)
class Fault:
    subject: str
    technique: str
    tags: tuple[str, ...]
    ts: str


def _append(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(payload, sort_keys=True) + "\n")


def append_verdict(path: Path, v: Verdict) -> None:
    _append(path, asdict(v))


def read_verdicts(path: Path) -> list[Verdict]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            out.append(Verdict(**json.loads(line)))
    return out


def append_fault(path: Path, f: Fault) -> None:
    _append(path, {**asdict(f), "tags": list(f.tags)})


def read_faults(path: Path) -> list[Fault]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            d = json.loads(line)
            out.append(Fault(subject=d["subject"], technique=d["technique"],
                             tags=tuple(d["tags"]), ts=d["ts"]))
    return out


def fresh_verdicts(verdicts: list[Verdict], plate_hashes: dict[str, str]) -> list[Verdict]:
    """Verdicts still cast on the CURRENT pixels of a known subject."""
    return [v for v in verdicts if plate_hashes.get(v.subject) == v.plate_hash]


def atomic_write_bytes(path: Path, data: bytes) -> None:
    """Write via temp + replace, so a crash cannot leave a truncated file that
    later reads as a legitimate render."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)

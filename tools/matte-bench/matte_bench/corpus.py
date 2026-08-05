"""Test subjects, organised by image CHARACTERISTIC rather than product role.

Foliage and lettering fail differently whatever the asset is called, so roles
do not predict matting difficulty. Plates are rendered with `dev-opaque` —
which is `dev-transparent` minus the matting node — giving the exact
pre-matting pixels every technique then competes on.
"""
import hashlib
import json
import shutil
from dataclasses import dataclass
from pathlib import Path

from app.assets.comfy import ImageEvent, LiveComfyProvider, ProgressEvent
from app.assets.graph import build_graph

from matte_bench.store import atomic_write_bytes

BUCKETS = (
    "wispy", "filigree", "enclosed-holes", "glow-soft",
    "crisp-text", "low-contrast", "busy-background",
)

PLATE_WORKFLOW = "dev-opaque"


@dataclass(frozen=True)
class Subject:
    id: str
    bucket: str
    prompt: str
    seed: int
    width: int
    height: int


def load_subjects(path: Path) -> list[Subject]:
    out = []
    for d in json.loads(path.read_text(encoding="utf-8")):
        if d["bucket"] not in BUCKETS:
            raise ValueError(f"unknown bucket: {d['bucket']}")
        out.append(Subject(id=d["id"], bucket=d["bucket"], prompt=d["prompt"],
                           seed=int(d["seed"]), width=int(d["width"]),
                           height=int(d["height"])))
    return out


def plate_path(root: Path, subject_id: str) -> Path:
    return root / "plates" / f"{subject_id}.png"


def plate_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


def plate_hashes(subjects: list[Subject], root: Path) -> dict[str, str]:
    out = {}
    for s in subjects:
        p = plate_path(root, s.id)
        if p.exists():
            out[s.id] = plate_hash(p.read_bytes())
    return out


def plate_params(s: Subject) -> dict:
    """Everything that determines a plate's pixels. Stored beside the plate;
    a mismatch (edited prompt, changed seed) invalidates the cache."""
    return {"prompt": s.prompt, "seed": s.seed, "width": s.width,
            "height": s.height, "workflow": PLATE_WORKFLOW}


def _plate_meta_path(root: Path, subject_id: str) -> Path:
    return root / "plates" / f"{subject_id}.json"


def _plate_is_current(s: Subject, root: Path) -> bool:
    meta = _plate_meta_path(root, s.id)
    if not plate_path(root, s.id).exists() or not meta.exists():
        return False
    try:
        return json.loads(meta.read_text(encoding="utf-8")) == plate_params(s)
    except (OSError, json.JSONDecodeError):
        return False


async def ensure_plate(s: Subject, root: Path, comfy_url: str,
                       on_progress=None) -> Path:
    """Render the plate once per (prompt, seed, size, workflow); reuse until
    the subject definition changes. A plate with no sidecar predates
    provenance tracking and is regenerated rather than trusted.

    `on_progress` receives ComfyUI's diffusion progress as a 0..1 fraction."""
    dest = plate_path(root, s.id)
    if _plate_is_current(s, root):
        return dest
    graph = build_graph(PLATE_WORKFLOW, s.prompt, s.width, s.height, s.seed)
    image = None
    async for ev in LiveComfyProvider(base_url=comfy_url).generate(graph):
        if isinstance(ev, ProgressEvent) and on_progress is not None and ev.max > 0:
            on_progress(ev.value / ev.max)
        if isinstance(ev, ImageEvent):
            image = ev.data
    if not image:
        raise RuntimeError(f"no plate produced for subject {s.id}")
    # A regenerated plate orphans every render cut from the old one; serving
    # them would pair sides from two different source images. (Layout shared
    # with render.render_path, which corpus cannot import without a cycle.)
    shutil.rmtree(root / "renders" / s.id, ignore_errors=True)
    atomic_write_bytes(dest, image)
    # Sidecar written last: a crash in between leaves a plate without
    # provenance, which is treated as stale and regenerated.
    atomic_write_bytes(_plate_meta_path(root, s.id),
                       json.dumps(plate_params(s), sort_keys=True).encode("utf-8"))
    return dest

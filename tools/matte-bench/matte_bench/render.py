"""Apply one technique to one cached plate (Class A), or generate the subject
fresh (Class B), and cache the result.

Class A never regenerates: the plate is uploaded to ComfyUI once and each
technique runs only its matting node over it, so the comparison isolates the
mask instead of confounding it with a different image.

Class B has no plate to remat: each technique renders its own pixels (a
backdrop-and-key generation, or a native-RGBA graph), so the shared tail below
only covers post-ops and the cache write.
"""
from io import BytesIO
from pathlib import Path

import httpx
from PIL import Image

from app.assets.comfy import ImageEvent, LiveComfyProvider, ProgressEvent
from app.assets.graph import build_graph

from matte_bench.corpus import PLATE_WORKFLOW, Subject, plate_path
from matte_bench.keying import chroma_key
from matte_bench.postops import apply_postops
from matte_bench.store import atomic_write_bytes
from matte_bench.techniques import Technique, config_hash, matting_graph, qwen_graph


class RenderError(Exception):
    def __init__(self, technique_id: str, reason: str):
        super().__init__(f"{technique_id}: {reason}")
        self.technique_id = technique_id
        self.reason = reason


def render_path(root: Path, subject_id: str, t: Technique) -> Path:
    return root / "renders" / subject_id / f"{config_hash(t)}.png"


def upload_plate(base_url: str, plate: Path) -> str:
    """Put the plate on the ComfyUI server; returns the name LoadImage wants."""
    files = {"image": (plate.name, plate.read_bytes(), "image/png")}
    resp = httpx.post(f"{base_url.rstrip('/')}/upload/image", files=files,
                      data={"overwrite": "true"}, timeout=120.0)
    resp.raise_for_status()
    body = resp.json()
    sub = body.get("subfolder") or ""
    return f"{sub}/{body['name']}" if sub else body["name"]


def backdrop_prompt(subject_prompt: str, clause: str) -> str:
    return f"{subject_prompt}, {clause}"


async def _generate(graph: dict, comfy_url: str, on_progress) -> bytes | None:
    image = None
    async for ev in LiveComfyProvider(base_url=comfy_url).generate(graph):
        if isinstance(ev, ProgressEvent) and on_progress is not None and ev.max > 0:
            on_progress(ev.value / ev.max)
        if isinstance(ev, ImageEvent):
            image = ev.data
    return image


async def _produce_class_a(s: Subject, t: Technique, root: Path,
                           comfy_url: str, on_progress) -> bytes | None:
    plate = plate_path(root, s.id)
    if not plate.exists():
        raise RenderError(t.id, f"no plate for subject {s.id}")
    name = upload_plate(comfy_url, plate)
    return await _generate(matting_graph(t, name), comfy_url, on_progress)


async def _produce_class_b(s: Subject, t: Technique, comfy_url: str,
                           on_progress) -> bytes | None:
    if t.node == "backdrop-key":
        prompt = backdrop_prompt(s.prompt, t.params["clause"])
        graph = build_graph(PLATE_WORKFLOW, prompt, s.width, s.height, s.seed)
        image = await _generate(graph, comfy_url, on_progress)
        if not image:
            return image
        keyed = chroma_key(Image.open(BytesIO(image)).convert("RGB"),
                           tuple(t.params["key_color"]),
                           t.params["tolerance"], t.params["softness"],
                           bool(t.params.get("despill", 1)))
        buf = BytesIO()
        keyed.save(buf, "PNG")
        return buf.getvalue()
    if t.node == "qwen-layered":
        graph = qwen_graph(t, s.prompt, s.width, s.height, s.seed)
        return await _generate(graph, comfy_url, on_progress)
    raise RenderError(t.id, f"unknown class B node: {t.node}")


async def ensure_render(s: Subject, t: Technique, root: Path, comfy_url: str,
                        on_progress=None) -> Path:
    """`on_progress` receives ComfyUI's progress as a 0..1 fraction."""
    dest = render_path(root, s.id, t)
    if dest.exists():
        return dest
    try:
        if t.cls == "B":
            image = await _produce_class_b(s, t, comfy_url, on_progress)
        else:
            image = await _produce_class_a(s, t, root, comfy_url, on_progress)
    except RenderError:
        raise
    except Exception as exc:                          # noqa: BLE001 - reported, not swallowed
        raise RenderError(t.id, str(exc)) from exc
    if not image:
        raise RenderError(t.id, "rendering produced no image")
    if t.post:
        img = apply_postops(Image.open(BytesIO(image)).convert("RGBA"), t.post)
        buf = BytesIO()
        img.save(buf, "PNG")
        image = buf.getvalue()
    atomic_write_bytes(dest, image)
    return dest

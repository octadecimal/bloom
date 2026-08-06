"""What a technique is, and how it becomes a ComfyUI graph.

Class A techniques re-mat a CACHED plate: the graph loads an already-uploaded
image and runs only the matting node, so every Class A comparison is judged on
byte-identical art.
"""
import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path

_DEFAULTS = {"background": "Alpha", "refine_foreground": True,
             "mask_blur": 0, "mask_offset": 0, "invert_output": False}

# RMBG exposes only a model choice; BiRefNetRMBG takes the full param set.
_NODE_PARAMS = {
    "BiRefNetRMBG": ("background", "refine_foreground", "mask_blur",
                     "mask_offset", "invert_output"),
    "RMBG": (),
}


@dataclass(frozen=True)
class Technique:
    id: str
    cls: str                 # "A" (same pixels) | "B" (different pixels)
    node: str
    model: str
    params: dict = field(default_factory=dict)
    post: tuple[tuple[str, float], ...] = ()

    def __eq__(self, other) -> bool:
        if not isinstance(other, Technique):
            return NotImplemented
        return config_hash(self) == config_hash(other)

    def __hash__(self) -> int:
        return hash(config_hash(self))


def config_hash(t: Technique) -> str:
    """Stable over everything that changes the OUTPUT — deliberately not the id,
    so renaming a technique does not invalidate its verdicts."""
    payload = json.dumps(
        {"cls": t.cls, "node": t.node, "model": t.model,
         "params": t.params, "post": [list(p) for p in t.post]},
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def load_techniques(path: Path) -> list[Technique]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    return [
        Technique(id=d["id"], cls=d["cls"], node=d["node"], model=d["model"],
                  params=d.get("params") or {},
                  post=tuple(tuple(p) for p in (d.get("post") or [])))
        for d in raw
    ]


def _slug(node: str, model: str) -> str:
    text = f"{node}-{model}".lower()
    text = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in text).strip("-")
    while "--" in text:
        text = text.replace("--", "-")
    return text


def stage1_models(available: dict[str, list[str]]) -> list[Technique]:
    """One default-param technique per installed model — stage 1 of the sweep."""
    out = []
    for node, models in available.items():
        for model in models:
            out.append(Technique(id=_slug(node, model), cls="A", node=node,
                                 model=model, params={}, post=()))
    return out


# Class B, family 1: generate the subject on a flat key-colored backdrop and
# key the color out afterwards (see matte_bench.keying). The clause is part of
# the technique config, so editing it re-renders (config_hash covers params).
BACKDROP_VARIANTS = (
    ("chroma-green", (0, 177, 64),
     "isolated on a solid flat chroma green (#00B140) studio backdrop, "
     "even lighting, no shadows on the backdrop"),
    ("chroma-magenta", (255, 0, 144),
     "isolated on a solid flat chroma magenta (#FF0090) studio backdrop, "
     "even lighting, no shadows on the backdrop"),
)


def backdrop_techniques() -> list[Technique]:
    out = []
    for name, key_color, clause in BACKDROP_VARIANTS:
        out.append(Technique(
            id=f"backdrop-{name}", cls="B", node="backdrop-key", model=name,
            params={"clause": clause, "key_color": list(key_color),
                    "tolerance": 60, "softness": 60, "despill": 1},
            post=()))
    return out


def qwen_techniques(weights: dict | None) -> list[Technique]:
    """Class B, family 2: native-RGBA generation. Materializes only when the
    probe found the full weight trio (see README-qwen.md for the install)."""
    if not weights:
        return []
    return [Technique(id="qwen-layered", cls="B", node="qwen-layered",
                      model=weights["unet"],
                      params={"clip": weights["clip"], "vae": weights["vae"]},
                      post=())]


def matting_graph(t: Technique, image_name: str) -> dict:
    inputs = {"image": ["load", 0], "model": t.model}
    for key in _NODE_PARAMS.get(t.node, ()):
        inputs[key] = t.params.get(key, _DEFAULTS[key])
    return {
        "load": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "matte": {"class_type": t.node, "inputs": inputs},
        "save": {"class_type": "SaveImage",
                 "inputs": {"images": ["matte", 0], "filename_prefix": "mattebench"}},
    }

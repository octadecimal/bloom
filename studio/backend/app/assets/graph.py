import copy
import json
import random
from pathlib import Path

WORKFLOWS = {
    "schnell-opaque": "ai_slots_neon.json",
    "schnell-transparent": "ai_slots_transparent.json",
    "dev-transparent": "ai_slots_dev_transparent.json",
    "dev-opaque": "ai_slots_dev_opaque.json",
}

_WORKFLOW_DIR = Path(__file__).parent / "workflows"


def random_seed() -> int:
    return random.randint(0, 2**32 - 1)


def load_base(workflow: str) -> dict:
    path = _WORKFLOW_DIR / WORKFLOWS[workflow]
    return json.loads(path.read_text(encoding="utf-8"))


_UPSCALE_IDS = ("up_loader", "up_apply", "up_scale")  # string ids avoid int collisions


def _insert_upscale(graph: dict, width: int, height: int, model_name: str) -> None:
    """Insert UpscaleModelLoader -> ImageUpscaleWithModel -> ImageScale after
    VAEDecode (node '8'), repointing whatever read ['8',0] to the ImageScale."""
    loader, apply, scale = _UPSCALE_IDS
    graph[loader] = {"class_type": "UpscaleModelLoader",
                     "inputs": {"model_name": model_name}}
    graph[apply] = {"class_type": "ImageUpscaleWithModel",
                    "inputs": {"upscale_model": [loader, 0], "image": ["8", 0]}}
    graph[scale] = {"class_type": "ImageScale",
                    "inputs": {"image": [apply, 0], "upscale_method": "lanczos",
                               "width": width, "height": height, "crop": "disabled"}}
    for nid, node in graph.items():
        if nid in (apply, scale, "8"):
            continue
        for key, val in (node.get("inputs") or {}).items():
            if val == ["8", 0]:
                node["inputs"][key] = [scale, 0]


def patch_graph(base: dict, prompt: str, width: int, height: int, seed: int, *,
                negative: str | None = None, steps: int | None = None,
                cfg: float | None = None, guidance: float | None = None,
                upscale: bool = False, upscale_model: str = "4x-UltraSharp.pth") -> dict:
    graph = copy.deepcopy(base)
    graph["6"]["inputs"]["text"] = prompt
    graph["5"]["inputs"]["width"] = width
    graph["5"]["inputs"]["height"] = height
    graph["3"]["inputs"]["seed"] = seed
    if negative is not None and "7" in graph:
        graph["7"]["inputs"]["text"] = negative
    if steps is not None:
        graph["3"]["inputs"]["steps"] = steps
    if cfg is not None:
        graph["3"]["inputs"]["cfg"] = cfg
    if guidance is not None and "11" in graph:
        graph["11"]["inputs"]["guidance"] = guidance
    if upscale:
        _insert_upscale(graph, width, height, upscale_model)
    return graph


def build_graph(workflow: str, prompt: str, width: int, height: int, seed: int, *,
                negative: str | None = None, steps: int | None = None,
                cfg: float | None = None, guidance: float | None = None,
                upscale: bool = False, upscale_model: str = "4x-UltraSharp.pth") -> dict:
    return patch_graph(load_base(workflow), prompt, width, height, seed,
                       negative=negative, steps=steps, cfg=cfg, guidance=guidance,
                       upscale=upscale, upscale_model=upscale_model)

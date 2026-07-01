import copy
import json
import random
from pathlib import Path

WORKFLOWS = {
    "schnell-opaque": "ai_slots_neon.json",
    "schnell-transparent": "ai_slots_transparent.json",
    "dev-transparent": "ai_slots_dev_transparent.json",
}

_WORKFLOW_DIR = Path(__file__).parent / "workflows"


def random_seed() -> int:
    return random.randint(0, 2**32 - 1)


def load_base(workflow: str) -> dict:
    path = _WORKFLOW_DIR / WORKFLOWS[workflow]
    return json.loads(path.read_text(encoding="utf-8"))


def patch_graph(base: dict, prompt: str, width: int, height: int, seed: int, *,
                negative: str | None = None, steps: int | None = None,
                cfg: float | None = None, guidance: float | None = None) -> dict:
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
    return graph


def build_graph(workflow: str, prompt: str, width: int, height: int, seed: int, *,
                negative: str | None = None, steps: int | None = None,
                cfg: float | None = None, guidance: float | None = None) -> dict:
    return patch_graph(load_base(workflow), prompt, width, height, seed,
                       negative=negative, steps=steps, cfg=cfg, guidance=guidance)

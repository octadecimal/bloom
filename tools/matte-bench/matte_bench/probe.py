"""Ask ComfyUI which matting models are actually installed.

The node classes existing does not mean the weights are downloaded. Ranking
eight models while the operator believes they are seeing fifteen is a silent
lie, so availability is probed and reported, never assumed.
"""
import httpx

MATTING_NODES = ("BiRefNetRMBG", "RMBG")


def fetch_object_info(base_url: str) -> dict:
    resp = httpx.get(f"{base_url.rstrip('/')}/object_info", timeout=120.0)
    resp.raise_for_status()
    return resp.json()


def available_models(object_info: dict) -> dict[str, list[str]]:
    """Node class -> installed model names, for matting nodes only."""
    out: dict[str, list[str]] = {}
    for node in MATTING_NODES:
        spec = object_info.get(node)
        if not spec:
            continue
        choices = (spec.get("input", {}).get("required", {}).get("model") or [None])[0]
        if isinstance(choices, list) and choices:
            out[node] = list(choices)
    return out

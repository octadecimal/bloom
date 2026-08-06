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


def _loader_choices(object_info: dict, node: str, key: str) -> list[str]:
    spec = object_info.get(node) or {}
    choices = (spec.get("input", {}).get("required", {}).get(key) or [None])[0]
    return list(choices) if isinstance(choices, list) else []


def checkpoint_installed(object_info: dict, ckpt_name: str) -> bool:
    """True when either loader can load this model by name."""
    return (ckpt_name in _loader_choices(object_info, "CheckpointLoaderSimple", "ckpt_name")
            or ckpt_name in _loader_choices(object_info, "UNETLoader", "unet_name"))


def plate_checkpoint(graph: dict) -> str | None:
    """The generator model a built graph loads — probed from the graph itself
    so a workflow swap cannot silently desync the availability check."""
    for node in graph.values():
        if node.get("class_type") in ("CheckpointLoaderSimple", "UNETLoader"):
            inputs = node.get("inputs") or {}
            return inputs.get("ckpt_name") or inputs.get("unet_name")
    return None


def qwen_weights(object_info: dict) -> dict | None:
    """The Qwen-Image weight trio, or None. All three files plus the layered
    latent node must be present — a partial install reads as not installed,
    never as a false positive."""
    unet = [n for n in _loader_choices(object_info, "UNETLoader", "unet_name")
            if "qwen_image" in n.lower() and "vae" not in n.lower()]
    clip = [n for n in _loader_choices(object_info, "CLIPLoader", "clip_name")
            if "qwen" in n.lower()]
    vae = [n for n in _loader_choices(object_info, "VAELoader", "vae_name")
           if "qwen_image_vae" in n.lower()]
    if unet and clip and vae and "EmptyQwenImageLayeredLatentImage" in object_info:
        return {"unet": unet[0], "clip": clip[0], "vae": vae[0]}
    return None

"""Bring a judging session up: probe available models, build state.

Rendering is lazy: bootstrap no longer renders plates or techniques. Doing so
meant a 30-60 minute wait staring at a terminal before the operator could
judge anything. Instead, `/api/next` (see web.py) renders exactly the two
images it is about to serve, and a technique that fails to render is
discovered and dropped at that moment rather than in a pre-flight sweep.
"""
from pathlib import Path

from matte_bench.corpus import Subject, load_subjects, plate_hashes
from matte_bench.probe import available_models, fetch_object_info
from matte_bench.techniques import Technique, config_hash, stage1_models


def install_state(state, subjects: list[Subject], techniques: list[Technique],
                  root: Path, comfy_url: str) -> None:
    state.root = root
    state.subjects = subjects
    state.techniques = [config_hash(t) for t in techniques]
    state.technique_names = {config_hash(t): f"{t.node}/{t.model}" for t in techniques}
    state.technique_objs = {config_hash(t): t for t in techniques}
    state.plate_hashes = plate_hashes(subjects, root)
    state.comfy_url = comfy_url


async def bootstrap(root: Path, subjects_path: Path, comfy_url: str):
    subjects = load_subjects(subjects_path)
    warnings: list[str] = []
    try:
        techniques = stage1_models(available_models(fetch_object_info(comfy_url)))
    except Exception as exc:                          # noqa: BLE001 - reported, not swallowed
        warnings.append(f"probe failed: {exc}")
        techniques = []
    return subjects, techniques, warnings

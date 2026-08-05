"""Bring a judging session up: probe, render what is missing, install state.

Techniques that cannot render are REPORTED, never silently dropped — ranking
eight models while the operator believes they are seeing fifteen would be a
silent lie.
"""
from pathlib import Path

from matte_bench.corpus import Subject, ensure_plate, load_subjects, plate_hashes
from matte_bench.probe import available_models, fetch_object_info
from matte_bench.render import RenderError, ensure_render
from matte_bench.techniques import Technique, config_hash, stage1_models


def install_state(state, subjects: list[Subject], techniques: list[Technique],
                  root: Path) -> None:
    state.root = root
    state.subjects = subjects
    state.techniques = [config_hash(t) for t in techniques]
    state.plate_hashes = plate_hashes(subjects, root)


async def bootstrap(root: Path, subjects_path: Path, comfy_url: str):
    subjects = load_subjects(subjects_path)
    techniques = stage1_models(available_models(fetch_object_info(comfy_url)))
    warnings: list[str] = []

    for s in subjects:
        await ensure_plate(s, root, comfy_url)

    usable: list[Technique] = []
    for t in techniques:
        ok = True
        for s in subjects:
            try:
                await ensure_render(s, t, root, comfy_url)
            except RenderError as exc:
                warnings.append(f"{t.id} unavailable: {exc.reason}")
                ok = False
                break
        if ok:
            usable.append(t)
    return subjects, usable, warnings

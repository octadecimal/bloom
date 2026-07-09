"""Seed template for new game-definition docs: the canonical composed demo
fixtures (spec section 4). Loaded from the repo files, not duplicated here."""

import json
from functools import lru_cache
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
_DEMO_DIR = REPO_ROOT / "runtime" / "server" / "demo"


@lru_cache(maxsize=2)
def _load(name: str) -> str:
    return (_DEMO_DIR / name).read_text(encoding="utf-8")


def default_definition() -> dict:
    return json.loads(_load("composed.definition.json"))


def default_presentation() -> dict:
    return json.loads(_load("composed.presentation.json"))

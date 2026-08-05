"""Templates for game-definition docs.

Two distinct things live here, and conflating them was a bug:

- `empty_definition()` is what a NEW game is seeded with. A game must start
  with no mechanics — one appears only when it is explicitly added. The seed
  exists purely so the pane has a doc to read (RoomRoute GETs the definition
  unconditionally), not to describe a game.
- `default_definition()` / `default_presentation()` are the canonical composed
  DEMO fixtures (spec section 4), loaded from the repo files rather than
  duplicated here. They are an example game — useful for tests and as a
  reference — and must NOT be used to seed a new game, or every game starts
  life owning the demo's reels + bonus meter.
"""

import json
from functools import lru_cache
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
_DEMO_DIR = REPO_ROOT / "runtime" / "server" / "demo"


@lru_cache(maxsize=2)
def _load(name: str) -> str:
    return (_DEMO_DIR / name).read_text(encoding="utf-8")


def empty_definition() -> dict:
    """A composed@1 shell with nothing in it.

    Byte-for-byte the same shape as the frontend's `emptyDefinition()` in
    studio/frontend/src/plugins/game-structure/model.ts — one definition of
    "empty" across the stack, so a fresh doc round-trips through the pane
    unchanged. Note `states` is empty and `start` is "": seeding even a
    default `base` state would put a state in the game the user never added,
    which is the same bug as seeding the demo's mechanics.
    """
    return {
        "family": "composed@1",
        "mechanics": [],
        "states": [],
        "start": "",
        "transitions": [],
        "caps": {"max_steps": 1000},
    }


def default_definition() -> dict:
    return json.loads(_load("composed.definition.json"))


def default_presentation() -> dict:
    return json.loads(_load("composed.presentation.json"))

"""The compose build job shape, shared by the REST build endpoint and the
auto-builder. game_id is a trust boundary: it becomes a file name — mirror the
Rust allow-list in runtime/server/src/state.rs resolve()."""
import hashlib
import re

from app.compose.templates import REPO_ROOT

SEED_COUNT = 10_000
GAME_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def master_seed(game_id: str) -> int:
    # Deterministic per game so rebuilds reproduce the same pool.
    return int.from_bytes(hashlib.sha256(game_id.encode()).digest()[:8], "big")


def build_job(game_id: str, definition: dict, presentation: dict, settings) -> dict:
    out_dir = REPO_ROOT / settings.packages_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    return {
        "definition": definition,
        "presentation": presentation,
        "package_id": game_id,
        "seed_count": SEED_COUNT,
        "master_seed": master_seed(game_id),
        "out_path": str(out_dir / f"{game_id}.pkg"),
        "validate_only": False,
    }

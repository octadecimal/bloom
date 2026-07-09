import hashlib
import re

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from app.compose.models import compose_wire
from app.compose.templates import REPO_ROOT

router = APIRouter()

SEED_COUNT = 10_000

# Trust boundary: game_id becomes a filename (out_path below). Mirror the
# Rust allow-list in runtime/server/src/state.rs's resolve().
_GAME_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def _validate_game_id(game_id: str) -> None:
    if not _GAME_ID_RE.fullmatch(game_id):
        raise HTTPException(status_code=400, detail="invalid game_id")


def _master_seed(game_id: str) -> int:
    # Deterministic per game so rebuilds reproduce the same pool (spec section 5).
    return int.from_bytes(hashlib.sha256(game_id.encode()).digest()[:8], "big")


class PutGameDefinitionBody(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    definition: dict | None = None
    presentation: dict | None = None
    source: str = "api"


class ValidateGameDefinitionBody(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    definition: dict | None = None


@router.get("/games/{game_id}/game-definition")
async def get_game_definition(game_id: str, request: Request) -> dict:
    doc = await request.app.state.compose_store.get_or_seed(game_id)
    return compose_wire(doc)


@router.put("/games/{game_id}/game-definition")
async def put_game_definition(game_id: str, body: PutGameDefinitionBody, request: Request) -> dict:
    doc = await request.app.state.compose_store.put(
        game_id, definition=body.definition, presentation=body.presentation, source=body.source
    )
    return compose_wire(doc)


@router.post("/games/{game_id}/game-definition/validate")
async def validate_game_definition(
    game_id: str, body: ValidateGameDefinitionBody, request: Request
) -> dict:
    definition = body.definition
    if definition is None:
        definition = (await request.app.state.compose_store.get_or_seed(game_id)).definition
    job = {
        "definition": definition,
        "package_id": game_id,
        "master_seed": _master_seed(game_id),
        "validate_only": True,
    }
    res = await request.app.state.compose_runner.run(job)
    return {"ok": bool(res.get("ok")), "errors": res.get("errors", [])}


@router.post("/games/{game_id}/game-definition/build")
async def build_game_definition(game_id: str, request: Request) -> dict:
    _validate_game_id(game_id)
    doc = await request.app.state.compose_store.get_or_seed(game_id)
    out_dir = REPO_ROOT / request.app.state.settings.packages_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    job = {
        "definition": doc.definition,
        "presentation": doc.presentation,
        "package_id": game_id,
        "seed_count": SEED_COUNT,
        "master_seed": _master_seed(game_id),
        "out_path": str(out_dir / f"{game_id}.pkg"),
        "validate_only": False,
    }
    res = await request.app.state.compose_runner.run(job)
    return {
        "ok": bool(res.get("ok")),
        "errors": res.get("errors"),
        "metrics": res.get("metrics"),
        "packageId": game_id,
    }

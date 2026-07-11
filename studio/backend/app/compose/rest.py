from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from app.compose.jobs import GAME_ID_RE, build_job, master_seed
from app.compose.models import compose_wire

router = APIRouter()


def _validate_game_id(game_id: str) -> None:
    if not GAME_ID_RE.fullmatch(game_id):
        raise HTTPException(status_code=400, detail="invalid game_id")


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
        "master_seed": master_seed(game_id),
        "validate_only": True,
    }
    res = await request.app.state.compose_runner.run(job)
    return {"ok": bool(res.get("ok")), "errors": res.get("errors", [])}


@router.post("/games/{game_id}/game-definition/build")
async def build_game_definition(game_id: str, request: Request) -> dict:
    _validate_game_id(game_id)
    doc = await request.app.state.compose_store.get_or_seed(game_id)
    job = build_job(game_id, doc.definition, doc.presentation, request.app.state.settings)
    res = await request.app.state.compose_runner.run(job)
    return {
        "ok": bool(res.get("ok")),
        "errors": res.get("errors"),
        "metrics": res.get("metrics"),
        "packageId": game_id,
    }

import asyncio
from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel
from app.simulator.models import CurationParams, sim_wire

router = APIRouter()


class PutSlotModelBody(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    model: dict | None = None
    params: CurationParams | None = None
    presentation: dict | None = None
    source: str = "api"


@router.get("/games/{game_id}/slot-model")
async def get_slot_model(game_id: str, request: Request) -> dict:
    doc = await request.app.state.sim_store.get_or_seed(game_id)
    return sim_wire(doc)


@router.put("/games/{game_id}/slot-model")
async def put_slot_model(game_id: str, body: PutSlotModelBody, request: Request) -> dict:
    doc = await request.app.state.sim_store.put(
        game_id, model=body.model, params=body.params,
        presentation=body.presentation, source=body.source)
    return sim_wire(doc)


@router.post("/games/{game_id}/slot-model/curate", status_code=202)
async def curate_slot_model(game_id: str, request: Request) -> Response:
    asyncio.create_task(request.app.state.sim_hub.request_curation(game_id))
    return Response(status_code=202)


@router.get("/games/{game_id}/slot-model/result")
async def get_slot_model_result(game_id: str, request: Request) -> dict | None:
    doc = await request.app.state.sim_store.get(game_id)
    if doc is None or doc.result is None:
        return None
    return doc.result.model_dump(by_alias=True, mode="json")

import asyncio
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from app.simulator.models import sim_wire
from app.simulator.targets import derive_target, TargetGap
from app.tuner.models import TuningParams, tuner_wire

router = APIRouter()


class PutTunerBody(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    params: TuningParams | None = None


@router.get("/games/{game_id}/tuner")
async def get_tuner(game_id: str, request: Request) -> dict:
    doc = await request.app.state.tuner_store.get_or_seed(game_id)
    return tuner_wire(doc)


@router.put("/games/{game_id}/tuner")
async def put_tuner(game_id: str, body: PutTunerBody, request: Request) -> dict:
    doc = await request.app.state.tuner_store.put(game_id, params=body.params)
    return tuner_wire(doc)


@router.get("/games/{game_id}/tuner/seed")
async def get_tuner_seed(game_id: str, request: Request) -> dict:
    doc = await request.app.state.sim_store.get_or_seed(game_id)
    return {"model": doc.model}


@router.get("/games/{game_id}/tuner/target")
async def get_tuner_target(game_id: str, request: Request) -> dict:
    sim_doc = await request.app.state.sim_store.get_or_seed(game_id)
    model = sim_doc.model or {}
    num_bonuses = len(model.get("bonuses", []) or [])
    gdd = await request.app.state.gdd_store.get_doc(game_id, "math-model")
    math_model = getattr(gdd, "data", {}) if gdd is not None else {}
    try:
        return {"target": derive_target(math_model, sim_doc.params, num_bonuses)}
    except TargetGap as gap:
        return {"gap": gap.message}


@router.post("/games/{game_id}/tuner/tune", status_code=202)
async def tune_tuner(game_id: str, request: Request) -> Response:
    asyncio.create_task(request.app.state.tuner_hub.request_tune(game_id))
    return Response(status_code=202)


@router.post("/games/{game_id}/tuner/apply")
async def apply_tuner(game_id: str, request: Request) -> dict:
    doc = await request.app.state.tuner_store.get(game_id)
    tuned = doc.result.tuned_model if (doc and doc.result) else None
    if not tuned:
        raise HTTPException(status_code=400, detail="no tuned model to apply")
    updated = await request.app.state.sim_store.put(game_id, model=tuned)
    return sim_wire(updated)


@router.get("/games/{game_id}/tuner/result")
async def get_tuner_result(game_id: str, request: Request) -> dict | None:
    doc = await request.app.state.tuner_store.get(game_id)
    if doc is None or doc.result is None:
        return None
    return doc.result.model_dump(by_alias=True, mode="json")

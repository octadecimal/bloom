import asyncio

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from app.math import templates
from app.math.models import CurationParams, SectionLocks, TuningParams, sim_wire, tuner_view
from app.math.models import math_run_wire
from app.math.targets import derive_target, derive_num_bonuses, TargetGap

router = APIRouter()


class PutSlotModelBody(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    model: dict | None = None
    params: CurationParams | None = None
    presentation: dict | None = None
    locks: SectionLocks | None = None
    source: str = "api"


class PutTunerBody(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    params: TuningParams | None = None


class ApplyTemplateBody(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    name: str


# ── slot-model (was app/simulator/rest.py) ──────────────────────────────────
@router.get("/games/{game_id}/slot-model")
async def get_slot_model(game_id: str, request: Request) -> dict:
    doc = await request.app.state.math_store.get_or_seed(game_id)
    return sim_wire(doc)


@router.put("/games/{game_id}/slot-model")
async def put_slot_model(game_id: str, body: PutSlotModelBody, request: Request) -> dict:
    doc = await request.app.state.math_store.put(
        game_id, model=body.model, params=body.params,
        presentation=body.presentation, locks=body.locks, source=body.source)
    return sim_wire(doc)


@router.post("/games/{game_id}/slot-model/realize")
async def realize_slot_model_rest(game_id: str, request: Request) -> dict:
    from app.math.realize_flow import realize_game
    res = await realize_game(request.app.state.math_store,
                             request.app.state.gdd_store, game_id,
                             gdd_hub=request.app.state.gdd_hub)
    return {"realized": res.realized, "errors": res.errors,
            "warnings": res.warnings}


@router.post("/games/{game_id}/slot-model/curate", status_code=202)
async def curate_slot_model(game_id: str, request: Request) -> Response:
    asyncio.create_task(request.app.state.math_hub.request_curation(game_id))
    return Response(status_code=202)


@router.get("/games/{game_id}/slot-model/result")
async def get_slot_model_result(game_id: str, request: Request) -> dict | None:
    doc = await request.app.state.math_store.get(game_id)
    if doc is None or doc.result is None:
        return None
    return doc.result.model_dump(by_alias=True, mode="json")


# ── templates (NEW) ──────────────────────────────────────────────────────────
@router.get("/slot-model/templates")
async def list_slot_model_templates() -> list[dict]:
    return templates.list_templates()


@router.post("/games/{game_id}/slot-model/apply-template")
async def apply_slot_model_template(game_id: str, body: ApplyTemplateBody,
                                    request: Request) -> dict:
    try:
        template_model = templates.get_model(body.name)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"unknown template '{body.name}'")
    store = request.app.state.math_store
    doc = await store.get_or_seed(game_id)
    merged = templates.apply_template(doc.model or {}, template_model, doc.locks)
    updated = await store.put(game_id, model=merged, source="template")
    return sim_wire(updated)


# ── tuner (was app/tuner/rest.py; wire shapes preserved via tuner_view) ─────
@router.get("/games/{game_id}/tuner")
async def get_tuner(game_id: str, request: Request) -> dict:
    doc = await request.app.state.math_store.get_or_seed(game_id)
    return tuner_view(doc)


@router.put("/games/{game_id}/tuner")
async def put_tuner(game_id: str, body: PutTunerBody, request: Request) -> dict:
    doc = await request.app.state.math_store.put(game_id, tuner_params=body.params)
    return tuner_view(doc)


@router.get("/games/{game_id}/tuner/target")
async def get_tuner_target(game_id: str, request: Request) -> dict:
    doc = await request.app.state.math_store.get_or_seed(game_id)
    model = doc.model or {}
    gdd = await request.app.state.gdd_store.get_doc(game_id, "math-model")
    math_model = getattr(gdd, "data", {}) if gdd is not None else {}
    try:
        features_doc = await request.app.state.gdd_store.get_doc(game_id, "bonus-features")
        num_bonuses = derive_num_bonuses(
            features_doc.data if features_doc else {}, model)
        return {"target": derive_target(math_model, doc.params, num_bonuses)}
    except TargetGap as gap:
        return {"gap": gap.message}


@router.post("/games/{game_id}/math/generate", status_code=202)
async def generate_math(game_id: str, request: Request) -> Response:
    if not request.app.state.math_hub.begin_generate(game_id):
        raise HTTPException(status_code=409,
                            detail="a math run is already in progress for this game")
    return Response(status_code=202)


@router.post("/games/{game_id}/math/generate/cancel", status_code=202)
async def cancel_generate_math(game_id: str, request: Request) -> Response:
    if not request.app.state.math_hub.cancel_generate(game_id):
        raise HTTPException(status_code=409, detail="no active run")
    return Response(status_code=202)


@router.post("/games/{game_id}/tuner/apply")
async def apply_tuner(game_id: str, request: Request) -> dict:
    doc = await request.app.state.math_store.get(game_id)
    tuned = doc.tune_result.tuned_model if (doc and doc.tune_result) else None
    if not tuned:
        raise HTTPException(status_code=400, detail="no tuned model to apply")
    updated = await request.app.state.math_store.put(game_id, model=tuned,
                                                     source="tuner")
    return sim_wire(updated)


# ── analytics (was app/analytics/rest.py) ───────────────────────────────────
@router.get("/analytics/runs")
async def list_runs(game_id: str, request: Request, limit: int = 50) -> list[dict]:
    docs = await request.app.state.math_run_store.list_for_game(game_id, limit=limit)
    return [math_run_wire(doc) for doc in docs]


@router.get("/analytics/runs/{run_id}")
async def get_run(run_id: str, request: Request) -> dict:
    doc = await request.app.state.math_run_store.get(run_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="run not found")
    return math_run_wire(doc)

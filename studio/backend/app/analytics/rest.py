from fastapi import APIRouter, HTTPException, Request

from app.analytics.models import math_run_wire

router = APIRouter()


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

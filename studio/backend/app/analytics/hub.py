import uuid
from datetime import datetime, timezone

from app.analytics.models import MathRunDoc, math_run_wire
from app.tuner.models import TuneResult, TuningParams


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class AnalyticsHub:
    def __init__(self, sio, math_run_store):
        self._sio = sio
        self._runs = math_run_store

    async def record_run(
        self, game_id: str, params: TuningParams, result: TuneResult, duration_ms: int
    ) -> MathRunDoc | None:
        if result.status not in ("pass", "near_miss"):
            return None
        doc = MathRunDoc(
            id=str(uuid.uuid4()),
            game_id=game_id,
            params=params,
            verdict=result.verdict,
            metrics=result.metrics,
            trace=result.trace,
            profile=result.profile,
            created_at=_now(),
            duration_ms=duration_ms,
        )
        saved = await self._runs.append(doc)
        await self._sio.emit(
            "run_complete",
            {"gameId": game_id, "run": math_run_wire(saved)},
            room=game_id,
        )
        return saved

    async def attach_subscriber(self, game_id: str, sid: str) -> None:
        await self._sio.enter_room(sid, game_id)
        latest = await self._runs.list_for_game(game_id, limit=1)
        if latest:
            await self._sio.emit(
                "run_complete",
                {"gameId": game_id, "run": math_run_wire(latest[0])},
                to=sid,
            )

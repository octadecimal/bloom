"""Debounced background package build, fired from the definition on_change
hook so the scene's composed spin always plays the latest saved definition."""
import asyncio

from app.compose.jobs import GAME_ID_RE, build_job


class AutoBuilder:
    def __init__(self, runner, settings, sio, *, debounce_s: float = 1.5):
        self._runner = runner
        self._settings = settings
        self._sio = sio
        self._debounce_s = debounce_s
        self._tasks: dict[str, asyncio.Task] = {}

    def schedule(self, game_id: str, definition: dict, presentation: dict) -> None:
        if not GAME_ID_RE.fullmatch(game_id or ""):
            return
        prev = self._tasks.get(game_id)
        if prev is not None and not prev.done():
            prev.cancel()
        self._tasks[game_id] = asyncio.create_task(
            self._run(game_id, definition, presentation)
        )

    async def _run(self, game_id: str, definition: dict, presentation: dict) -> None:
        await asyncio.sleep(self._debounce_s)
        await self._emit(game_id, {"status": "building"})
        try:
            res = await self._runner.run(build_job(game_id, definition, presentation, self._settings))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # a crashed build must surface, not vanish
            await self._emit(game_id, {"status": "error", "errors": [str(exc)]})
            return
        ok = bool(res.get("ok"))
        await self._emit(game_id, {
            "status": "done" if ok else "error",
            "errors": res.get("errors") or [],
            "metrics": res.get("metrics"),
            "packageId": game_id,
        })

    async def _emit(self, game_id: str, fields: dict) -> None:
        await self._sio.emit("game_build_status", {"gameId": game_id, **fields}, room=game_id)

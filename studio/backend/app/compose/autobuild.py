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
        self._pending: dict[str, tuple[dict, dict]] = {}
        self._in_flight: set[str] = set()

    def schedule(self, game_id: str, definition: dict, presentation: dict) -> None:
        if not GAME_ID_RE.fullmatch(game_id or ""):
            return
        # Latest job wins; intermediate ones coalesce (only _pending matters).
        self._pending[game_id] = (definition, presentation)
        task = self._tasks.get(game_id)
        if task is not None and not task.done():
            if game_id in self._in_flight:
                # A build is past debounce and running — don't cancel it (that
                # would orphan the subprocess). Its loop picks up _pending next.
                return
            task.cancel()  # still debouncing: reset the window with the newest job
        self._tasks[game_id] = asyncio.create_task(self._run(game_id))

    async def _run(self, game_id: str) -> None:
        await asyncio.sleep(self._debounce_s)
        # Serialize per game: drain the latest queued job(s) one at a time so an
        # in-flight build is never raced by a newer one on the same out_path.
        while game_id in self._pending:
            definition, presentation = self._pending.pop(game_id)
            await self._emit(game_id, {"status": "building"})
            self._in_flight.add(game_id)
            try:
                res = await self._runner.run(
                    build_job(game_id, definition, presentation, self._settings)
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # a crashed build must surface, not vanish
                await self._emit(game_id, {"status": "error", "errors": [str(exc)]})
                continue
            finally:
                self._in_flight.discard(game_id)
            ok = bool(res.get("ok"))
            await self._emit(game_id, {
                "status": "done" if ok else "error",
                "errors": res.get("errors") or [],
                "metrics": res.get("metrics"),
                "packageId": game_id,
            })

    async def _emit(self, game_id: str, fields: dict) -> None:
        await self._sio.emit("game_build_status", {"gameId": game_id, **fields}, room=game_id)

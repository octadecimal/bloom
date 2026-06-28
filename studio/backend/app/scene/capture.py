"""Real-frame capture broker (vision-compose Plan 3).

Correlates a backend capture *request* — emitted to the game room over
Socket.IO as ``scene_capture_request`` — with the asynchronous
``scene_capture_result`` the studio relays back from the runtime-client iframe.
The Plan 4 compose-loop orchestrator calls ``request_capture`` and awaits the
decoded PNG bytes; the ``scene_capture_result`` socket handler calls
``resolve_capture`` when the studio posts the frame back. See
``docs/superpowers/specs/2026-06-27-vision-in-the-loop-scene-composition-design.md`` §2.
"""

import asyncio
import base64


def _decode_png(data_url: str) -> bytes:
    """Decode a ``data:image/png;base64,<...>`` URL (or a bare base64 string)."""
    payload = data_url.split(",", 1)[1] if data_url.startswith("data:") else data_url
    return base64.b64decode(payload)


class SceneCaptureBroker:
    """Awaitable request/response bridge for runtime-client frame captures."""

    def __init__(self, sio):
        self._sio = sio
        self._pending: dict[str, asyncio.Future] = {}
        self._seq = 0

    async def request_capture(self, game_id: str, *, timeout: float = 10.0) -> bytes:
        """Ask the game room to capture its rendered frame; return PNG bytes.

        Emits ``scene_capture_request`` with a fresh ``captureId`` and awaits the
        matching ``resolve_capture``. Raises ``asyncio.TimeoutError`` if no
        result arrives within ``timeout`` seconds (e.g. no client attached).
        """
        self._seq += 1
        capture_id = f"cap{self._seq}"
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        self._pending[capture_id] = fut
        await self._sio.emit(
            "scene_capture_request",
            {"gameId": game_id, "captureId": capture_id},
            room=game_id,
        )
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(capture_id, None)

    def resolve_capture(self, capture_id: str, png_data_url: str) -> None:
        """Complete the pending request for ``capture_id`` with decoded bytes.

        A no-op for an unknown / already-resolved id (late or duplicate reply).
        """
        fut = self._pending.get(capture_id)
        if fut is None or fut.done():
            return
        fut.set_result(_decode_png(png_data_url))

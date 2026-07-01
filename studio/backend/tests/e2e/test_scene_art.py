"""Backend non-browser e2e for the real-frame art stage (sub-project B).

Both tests drive the SAME pirate compose prompt as test_scene_compose.py through
the design-router (replay). One attaches a fake client that answers the capture
request (so the art stage runs its real capture round trip); the other never
answers (so the art stage times out fast and skips). Uses the default scene_art
cassette (premium, no regen) — the regenerate PATH is covered deterministically in
tests/test_compose_art_stage.py.
"""
import asyncio

import httpx
import pytest
import socketio

PROMPT = "make a pirate theme game with a background and a logo centered at the top"


async def _make_room(base_url: str) -> tuple[str, str]:
    async with httpx.AsyncClient(base_url=base_url) as http:
        room = (await http.post("/rooms", json={"name": "ArtE2E"})).json()
        return room["id"], room["gameId"]


async def _run_prompt(live_server, *, answer_capture: bool) -> list[dict]:
    room_id, game_id = await _make_room(live_server)
    client = socketio.AsyncClient()
    run_completions: list[dict] = []
    capture_requests: list[dict] = []
    client.on("run_completed", lambda d: run_completions.append(d))

    import base64

    async def _on_capture_request(data):
        capture_requests.append(data)
        if answer_capture:
            png = "data:image/png;base64," + base64.b64encode(b"\x89PNGtest").decode()
            await client.emit("scene_capture_result",
                              {"gameId": data["gameId"],
                               "captureId": data["captureId"], "png": png})

    client.on("scene_capture_request", _on_capture_request)
    await client.connect(live_server, auth={"displayName": "Designer"})
    await client.emit("join_room", {"roomId": room_id})
    await client.emit("join_scene", {"gameId": game_id})
    await asyncio.sleep(0.3)
    await client.emit("send_prompt", {"roomId": room_id, "text": PROMPT})

    deadline = asyncio.get_running_loop().time() + 40
    while not run_completions and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    await client.disconnect()
    assert run_completions, "run_completed not received"
    assert run_completions[0]["status"] == "completed", run_completions
    return capture_requests


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_art_stage_captures_real_frame_when_client_answers(live_server):
    capture_requests = await _run_prompt(live_server, answer_capture=True)
    # The art stage fired the real capture round trip against the attached client.
    assert capture_requests, "art stage did not request a real-frame capture"


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_art_stage_skips_and_build_completes_without_client(live_server):
    # A client is joined but NEVER answers capture -> art stage times out
    # (art_capture_timeout ~3s) and skips; the build still completes.
    capture_requests = await _run_prompt(live_server, answer_capture=False)
    assert capture_requests, "capture should still be requested"
    # The run completed despite no capture answer (asserted inside _run_prompt).

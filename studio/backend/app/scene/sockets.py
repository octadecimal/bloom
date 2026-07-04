import secrets
from app.scene.document import OpError
from app.scene.reels_spin import derive_reels_config, map_grid

# Default canvas used when a game has no Root yet (idempotent: ensure_root keeps
# an existing Root's canvas).
_DEFAULT_CANVAS = (1080, 1920)


def register_scene_handlers(sio, hub, broker, model_store, spin_runner):
    @sio.on("join_scene")
    async def join_scene(sid, data):
        await hub.attach(data["gameId"], sid)

    @sio.on("leave_scene")
    async def leave_scene(sid, data):
        await sio.leave_room(sid, data["gameId"])

    @sio.on("scene_apply_op")
    async def scene_apply_op(sid, data):
        game_id = data.get("gameId")
        op = data.get("op") or {}
        # This slice only accepts setProp from clients; structural ops
        # (addNode/removeNode/connect/disconnect) stay agent/internal-only.
        if op.get("kind") != "setProp":
            await sio.emit(
                "scene_op_rejected",
                {"gameId": game_id, "code": "forbidden_kind", "op": op},
                to=sid,
            )
            return
        # Validate required keys are present; value: null is legitimate so check key
        # presence, not truthiness.
        if any(k not in op for k in ("id", "path", "value")):
            await sio.emit(
                "scene_op_rejected",
                {"gameId": game_id, "code": "bad_op", "op": op},
                to=sid,
            )
            return
        try:
            await hub.apply_op(game_id, op)
        except OpError as e:
            await sio.emit(
                "scene_op_rejected",
                {"gameId": game_id, "code": e.code, "op": op},
                to=sid,
            )

    @sio.on("scene_capture_result")
    async def scene_capture_result(sid, data):
        png = data.get("png")
        if broker is not None and png:
            broker.resolve_capture(data.get("captureId"), png)

    async def _model_for(game_id: str) -> dict:
        # get_or_seed guarantees a complete template model — a game's model is
        # never {} (spec decision 5), so the old DEMO fallback is gone.
        doc = await model_store.get_or_seed(game_id)
        return doc.model

    @sio.on("scene_add_module")
    async def scene_add_module(sid, data):
        game_id = data.get("gameId")
        mtype = data.get("type", "reels")
        await hub.ensure_root(game_id, _DEFAULT_CANVAS)
        config = derive_reels_config(await _model_for(game_id))
        await hub.set_modules(game_id, [{"id": "reels", "type": mtype, "config": config}])

    @sio.on("scene_spin")
    async def scene_spin(sid, data):
        game_id = data.get("gameId")
        seed = data.get("seed")
        if seed is None:
            seed = secrets.randbelow(2 ** 63)
        result = await spin_runner.run(await _model_for(game_id), int(seed))
        grid = map_grid(result["grid"])
        await sio.emit("scene_spin_outcome",
                       {"gameId": game_id, "outcome": {"grid": grid}}, room=game_id)

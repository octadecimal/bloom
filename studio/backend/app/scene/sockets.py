import secrets
from app.scene.document import OpError
from app.scene.composed_spin import ComposedSpinError
from app.scene.reels_spin import map_grid


def register_scene_handlers(sio, hub, broker, model_store, spin_runner, compose_store, composed_spin):
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

    @sio.on("scene_spin")
    async def scene_spin(sid, data):
        game_id = data.get("gameId")
        # A game WITH a composed definition plays the real math: the runtime
        # server draws/audits the round and returns a walkable trace. get(),
        # not get_or_seed(): a Spin must never conjure a definition.
        doc = await compose_store.get(game_id)
        if doc is not None:
            try:
                res = await composed_spin.spin(game_id)
            except ComposedSpinError as e:
                await sio.emit("scene_spin_error",
                               {"gameId": game_id, "message": str(e)}, room=game_id)
                return
            await sio.emit("scene_spin_trace",
                           {"gameId": game_id, "seed": res.get("seed"),
                            "outcome": res.get("outcome"), "trace": res.get("trace") or []},
                           room=game_id)
            return
        # Legacy SlotModel-era games: evaluate one round via spin_json.
        seed = data.get("seed")
        if seed is None:
            seed = secrets.randbelow(2 ** 63)
        result = await spin_runner.run(await _model_for(game_id), int(seed))
        grid = map_grid(result["grid"])
        await sio.emit("scene_spin_outcome",
                       {"gameId": game_id, "outcome": {"grid": grid}}, room=game_id)

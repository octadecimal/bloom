from app.scene.document import OpError


def register_scene_handlers(sio, hub):
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
        try:
            await hub.apply_op(game_id, op)
        except OpError as e:
            await sio.emit(
                "scene_op_rejected",
                {"gameId": game_id, "code": e.code, "op": op},
                to=sid,
            )

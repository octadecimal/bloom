def register_gdd_handlers(sio, hub):
    @sio.on("join_gdd")
    async def join_gdd(sid, data):
        await hub.attach(data["gameId"], sid)

    @sio.on("leave_gdd")
    async def leave_gdd(sid, data):
        await sio.leave_room(sid, data["gameId"])

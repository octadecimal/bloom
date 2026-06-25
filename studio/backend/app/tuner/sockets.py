def register_tuner_handlers(sio, hub):
    @sio.on("join_tuner")
    async def join_tuner(sid, data):
        await hub.attach_subscriber(data["gameId"], sid)

    @sio.on("leave_tuner")
    async def leave_tuner(sid, data):
        await sio.leave_room(sid, data["gameId"])

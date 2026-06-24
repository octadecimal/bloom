def register_sim_handlers(sio, hub):
    @sio.on("join_sim")
    async def join_sim(sid, data):
        await hub.attach_subscriber(data["gameId"], sid)

    @sio.on("leave_sim")
    async def leave_sim(sid, data):
        await sio.leave_room(sid, data["gameId"])

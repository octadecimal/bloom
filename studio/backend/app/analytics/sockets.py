def register_analytics_handlers(sio, hub):
    @sio.on("join_analytics")
    async def join_analytics(sid, data):
        await hub.attach_subscriber(data["gameId"], sid)

    @sio.on("leave_analytics")
    async def leave_analytics(sid, data):
        await sio.leave_room(sid, data["gameId"])

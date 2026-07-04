"""Socket subscriptions for the three legacy panes. Event names preserved."""


def register_math_handlers(sio, hub):
    @sio.on("join_sim")
    async def join_sim(sid, data):
        await hub.attach_sim_subscriber(data["gameId"], sid)

    @sio.on("leave_sim")
    async def leave_sim(sid, data):
        await sio.leave_room(sid, data["gameId"])

    @sio.on("join_tuner")
    async def join_tuner(sid, data):
        await hub.attach_tuner_subscriber(data["gameId"], sid)

    @sio.on("leave_tuner")
    async def leave_tuner(sid, data):
        await sio.leave_room(sid, data["gameId"])

    @sio.on("join_analytics")
    async def join_analytics(sid, data):
        await hub.attach_analytics_subscriber(data["gameId"], sid)

    @sio.on("leave_analytics")
    async def leave_analytics(sid, data):
        await sio.leave_room(sid, data["gameId"])

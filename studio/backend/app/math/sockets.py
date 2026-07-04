"""Socket subscriptions behind the unified Math pane, keeping the legacy
sim/analytics event names (the frontend still joins these rooms; only the
tuner-pane events are gone). join_tuner/leave_tuner pruned in Task 10 —
the tuner pane was deleted in Task 9."""


def register_math_handlers(sio, hub):
    @sio.on("join_sim")
    async def join_sim(sid, data):
        await hub.attach_sim_subscriber(data["gameId"], sid)

    @sio.on("leave_sim")
    async def leave_sim(sid, data):
        await sio.leave_room(sid, data["gameId"])

    @sio.on("join_analytics")
    async def join_analytics(sid, data):
        await hub.attach_analytics_subscriber(data["gameId"], sid)

    @sio.on("leave_analytics")
    async def leave_analytics(sid, data):
        await sio.leave_room(sid, data["gameId"])

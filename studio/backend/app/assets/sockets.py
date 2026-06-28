def register_asset_handlers(sio, hub):
    @sio.on("join_game")
    async def join_game(sid, data):
        await hub.attach_subscriber(data["gameId"], sid)

    @sio.on("leave_game")
    async def leave_game(sid, data):
        await sio.leave_room(sid, data["gameId"])

    @sio.on("generate_asset")
    async def generate_asset(sid, data):
        await hub.request_generation(data["gameId"], data["assetId"], auto_select=True)

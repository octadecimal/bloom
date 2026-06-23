def register_socket_handlers(sio, hub, presence):
    @sio.event
    async def connect(sid, environ, auth):
        name = (auth or {}).get("displayName") or "anon"
        await sio.save_session(sid, {"displayName": name})

    @sio.event
    async def disconnect(sid):
        for room_id in presence.leave_all(sid):
            await sio.emit("presence", {"roomId": room_id, "members": presence.members(room_id)}, room=room_id)

    @sio.on("join_room")
    async def join_room(sid, data):
        room_id = data["roomId"]
        session = await sio.get_session(sid)
        await hub.attach_subscriber(room_id, sid)
        presence.join(room_id, sid, session["displayName"])
        await sio.emit("presence", {"roomId": room_id, "members": presence.members(room_id)}, room=room_id)

    @sio.on("leave_room")
    async def leave_room(sid, data):
        room_id = data["roomId"]
        await sio.leave_room(sid, room_id)
        presence.leave(room_id, sid)
        await sio.emit("presence", {"roomId": room_id, "members": presence.members(room_id)}, room=room_id)

    @sio.on("send_prompt")
    async def send_prompt(sid, data):
        session = await sio.get_session(sid)
        await hub.handle_prompt(data["roomId"], session["displayName"], data["text"])

    @sio.on("run_skill")
    async def run_skill(sid, data):
        session = await sio.get_session(sid)
        await hub.handle_skill_run(
            data["roomId"], session["displayName"], data["skillName"], data.get("args", {}), data.get("text", "")
        )

    @sio.on("resolve_approval")
    async def resolve_approval(sid, data):
        await hub.resolve_approval(data["roomId"], data["runId"], data["decision"])

    @sio.on("typing")
    async def typing(sid, data):
        room_id = data["roomId"]
        session = await sio.get_session(sid)
        await sio.emit(
            "typing",
            {"roomId": room_id, "author": session["displayName"], "isTyping": bool(data["isTyping"])},
            room=room_id,
            skip_sid=sid,
        )

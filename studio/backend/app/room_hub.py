import asyncio

from app.models import message_wire


class RoomHub:
    def __init__(self, sio, store, chat_service):
        self._sio = sio
        self._store = store
        self._chat = chat_service
        self._queues: dict[str, list[str]] = {}
        self._busy: set[str] = set()
        self._locks: dict[str, asyncio.Lock] = {}

    def _lock(self, room_id: str) -> asyncio.Lock:
        return self._locks.setdefault(room_id, asyncio.Lock())

    async def handle_prompt(self, room_id: str, author: str, text: str) -> None:
        user_msg = await self._store.add_message(room_id, author, "user", text, "complete")
        await self._sio.emit("message_created", {"message": message_wire(user_msg)}, room=room_id)

        async with self._lock(room_id):
            self._queues.setdefault(room_id, []).append(user_msg.id)
            if room_id in self._busy:
                await self._emit_status(room_id, "queued")
                return
            self._busy.add(room_id)

        asyncio.create_task(self._drain(room_id))

    async def _drain(self, room_id: str) -> None:
        while True:
            async with self._lock(room_id):
                queue = self._queues.get(room_id, [])
                if not queue:
                    self._busy.discard(room_id)
                    await self._emit_status(room_id, "idle")
                    return
                queue.pop(0)
            try:
                await self._run_generation(room_id)
            except Exception:
                await self._sio.emit(
                    "error",
                    {"roomId": room_id, "message": "generation failed"},
                    room=room_id,
                )
                # keep draining remaining queued prompts rather than orphaning them

    async def _run_generation(self, room_id: str) -> None:
        room = await self._store.get_room(room_id)
        await self._emit_status(room_id, "generating")

        assistant = await self._store.add_message(room_id, "assistant", "assistant", "", "streaming")
        await self._sio.emit("message_created", {"message": message_wire(assistant)}, room=room_id)

        history = await self._store.list_messages(room_id)
        context = [m for m in history if m.id != assistant.id]

        content = ""
        async for token in self._chat.stream(context, room.model):
            content += token
            await self._sio.emit(
                "token",
                {"roomId": room_id, "messageId": assistant.id, "delta": token},
                room=room_id,
            )

        await self._store.complete_message(assistant.id, content)
        await self._sio.emit(
            "message_completed",
            {"roomId": room_id, "messageId": assistant.id},
            room=room_id,
        )

    async def _emit_status(self, room_id: str, state: str) -> None:
        depth = len(self._queues.get(room_id, []))
        await self._sio.emit(
            "ai_status",
            {"roomId": room_id, "state": state, "queueDepth": depth},
            room=room_id,
        )

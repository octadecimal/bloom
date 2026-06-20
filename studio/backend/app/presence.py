class PresenceRegistry:
    def __init__(self):
        self._rooms: dict[str, dict[str, str]] = {}

    def join(self, room_id: str, sid: str, name: str) -> None:
        self._rooms.setdefault(room_id, {})[sid] = name

    def leave(self, room_id: str, sid: str) -> None:
        room = self._rooms.get(room_id)
        if room:
            room.pop(sid, None)

    def leave_all(self, sid: str) -> list[str]:
        affected = []
        for room_id, members in self._rooms.items():
            if sid in members:
                members.pop(sid, None)
                affected.append(room_id)
        return affected

    def members(self, room_id: str) -> list[str]:
        return sorted(self._rooms.get(room_id, {}).values())

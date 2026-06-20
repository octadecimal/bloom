from app.presence import PresenceRegistry


def test_presence_tracks_and_removes_members():
    p = PresenceRegistry()
    p.join("r1", "sidA", "Alice")
    p.join("r1", "sidB", "Bob")
    assert p.members("r1") == ["Alice", "Bob"]

    affected = p.leave_all("sidA")
    assert affected == ["r1"]
    assert p.members("r1") == ["Bob"]

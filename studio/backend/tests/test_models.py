from datetime import datetime, timezone

from app.models import Message, message_wire


def test_message_wire_is_camel_case():
    msg = Message(
        id="m1",
        room_id="r1",
        author="Alice",
        role="user",
        content="hi",
        status="complete",
        created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    wire = message_wire(msg)
    assert wire["roomId"] == "r1"
    assert wire["createdAt"] == "2026-01-01T00:00:00Z"
    assert "room_id" not in wire

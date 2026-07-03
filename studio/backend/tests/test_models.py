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


def test_gen_params_round_trip_on_asset_wire():
    from app.assets.models import Asset, GenParams, asset_wire
    a = Asset(id="1", game_id="g", name="n", prompt="p", width=64, height=64,
              workflow="dev-transparent",
              params=GenParams(negative="blurry", steps=28, guidance=3.0, cfg=2.0, upscale=True))
    wire = asset_wire(a)
    assert wire["params"]["negative"] == "blurry"
    assert wire["params"]["upscale"] is True
    round = Asset.model_validate(wire)
    assert round.params.steps == 28

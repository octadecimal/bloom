from app.room_hub import RoomHub


def test_room_hub_stores_tuner_dependencies():
    hub = RoomHub(
        sio=None, store=None, chat_service=None,
        math_store="MATH_STORE", math_hub="MATH_HUB",
    )
    assert hub._math_store == "MATH_STORE"
    assert hub._math_hub == "MATH_HUB"

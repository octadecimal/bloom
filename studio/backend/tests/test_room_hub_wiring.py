from app.room_hub import RoomHub


def test_room_hub_stores_tuner_dependencies():
    hub = RoomHub(
        sio=None, store=None, chat_service=None,
        sim_store="SIM", tuner_store="TUNER", tuner_hub="HUB",
    )
    assert hub._sim_store == "SIM"
    assert hub._tuner_store == "TUNER"
    assert hub._tuner_hub == "HUB"

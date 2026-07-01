import pytest
import pytest_asyncio
from types import SimpleNamespace
from app.gdd.hub import GddHub
from app.gdd.store import GddStore
from app import rest


@pytest_asyncio.fixture(autouse=True)
async def _clear_gdd(mongo_db):
    await mongo_db["gdd_docs"].delete_many({})
    yield
    await mongo_db["gdd_docs"].delete_many({})


class _FakeSio:
    async def emit(self, event, data=None, **kwargs):
        pass

    async def enter_room(self, sid, room):
        pass


def _req(store):
    hub = GddHub(_FakeSio(), store)
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
        gdd_store=store, gdd_hub=hub,
    )))


@pytest.mark.asyncio
async def test_set_gdd_fields_seeds_and_sets(mongo_db):
    store = GddStore(mongo_db)
    out = await rest.set_gdd_fields_rest(
        "g1", "math-model", rest.SetGddFieldsBody(fields={"rtp": "90%", "volatility": "high"}), _req(store)
    )
    assert out["doc"]["aspect"] == "math-model"
    assert out["doc"]["data"]["rtp"] == 0.9
    # volatility is an enum field; it should be stored
    assert out["doc"]["data"]["volatility"] == "high"

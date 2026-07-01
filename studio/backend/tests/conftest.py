import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient

from app.config import Settings
from app.main import build


@pytest.fixture
def settings() -> Settings:
    return Settings(provider_mode="replay", mongo_db="bloom_studio_test")


@pytest.fixture
def ctx(settings):
    return build(settings)


_COLLECTIONS = [
    "rooms", "messages", "games", "assets", "runs",
    "slot_models", "region_overrides", "tuner_jobs",
]


@pytest_asyncio.fixture
async def mongo_db(settings):
    client = AsyncIOMotorClient(settings.mongo_url)
    db = client[settings.mongo_db]
    for coll in _COLLECTIONS:
        await db[coll].delete_many({})
    yield db
    for coll in _COLLECTIONS:
        await db[coll].delete_many({})
    client.close()

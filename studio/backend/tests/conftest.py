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


@pytest_asyncio.fixture
async def mongo_db(settings):
    client = AsyncIOMotorClient(settings.mongo_url)
    db = client[settings.mongo_db]
    await db["rooms"].delete_many({})
    await db["messages"].delete_many({})
    await db["games"].delete_many({})
    await db["assets"].delete_many({})
    yield db
    await db["rooms"].delete_many({})
    await db["messages"].delete_many({})
    await db["games"].delete_many({})
    await db["assets"].delete_many({})
    client.close()

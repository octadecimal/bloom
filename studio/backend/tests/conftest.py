import pytest

from app.config import Settings
from app.main import build


@pytest.fixture
def settings() -> Settings:
    return Settings(llm_backend="fake", mongo_db="bloom_studio_test")


@pytest.fixture
def ctx(settings):
    return build(settings)

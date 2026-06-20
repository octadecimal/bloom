from app.catalog import build_model_catalog
from app.config import Settings


def test_catalog_derives_label_and_free_flag():
    settings = Settings(available_models="openai/gpt-4o-mini,meta-llama/llama-3.2-3b-instruct:free")
    catalog = build_model_catalog(settings)
    assert catalog == [
        {"id": "openai/gpt-4o-mini", "label": "gpt-4o-mini", "free": False},
        {"id": "meta-llama/llama-3.2-3b-instruct:free", "label": "llama-3.2-3b-instruct", "free": True},
    ]


def test_catalog_ignores_blank_entries_and_whitespace():
    settings = Settings(available_models=" openai/gpt-4o-mini , , foo/bar:free ")
    catalog = build_model_catalog(settings)
    assert [c["id"] for c in catalog] == ["openai/gpt-4o-mini", "foo/bar:free"]

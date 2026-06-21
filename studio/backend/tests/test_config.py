import warnings
from app.config import Settings, get_settings


def test_default_mode_is_live():
    assert Settings().provider_mode == "live"


def test_legacy_fake_maps_to_replay(monkeypatch):
    monkeypatch.setenv("LLM_BACKEND", "fake")
    monkeypatch.setenv("COMFY_BACKEND", "fake")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        assert get_settings().provider_mode == "replay"


def test_legacy_openrouter_maps_to_live(monkeypatch):
    monkeypatch.setenv("LLM_BACKEND", "openrouter")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        assert get_settings().provider_mode == "live"


def test_legacy_emits_deprecation_warning(monkeypatch):
    monkeypatch.setenv("LLM_BACKEND", "fake")
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        get_settings()
    assert any(issubclass(w.category, DeprecationWarning) for w in caught)


def test_disagreement_prefers_replay(monkeypatch):
    monkeypatch.setenv("LLM_BACKEND", "openrouter")  # live
    monkeypatch.setenv("COMFY_BACKEND", "fake")       # replay
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        assert get_settings().provider_mode == "replay"

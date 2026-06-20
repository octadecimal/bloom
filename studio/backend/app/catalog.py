from app.config import Settings

_FREE_SUFFIX = ":free"


def _label_for(model_id: str) -> str:
    base = model_id.split("/")[-1]
    if base.endswith(_FREE_SUFFIX):
        base = base[: -len(_FREE_SUFFIX)]
    return base


def build_model_catalog(settings: Settings) -> list[dict]:
    ids = [m.strip() for m in settings.available_models.split(",") if m.strip()]
    return [
        {"id": mid, "label": _label_for(mid), "free": mid.endswith(_FREE_SUFFIX)}
        for mid in ids
    ]

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from app.gdd.schemas import schema_for

Status = Literal["empty", "drafted", "needs_input", "complete"]


class _WireModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class GddDoc(_WireModel):
    id: str
    game_id: str
    aspect: str
    title: str
    order: int
    data: dict = {}
    body: str = ""
    status: Status = "empty"
    created_at: datetime
    updated_at: datetime


GDD_TAXONOMY: list[dict] = [
    {"aspect": "theme", "title": "Theme & Narrative", "order": 1},
    {"aspect": "math-model", "title": "Math Model", "order": 2},
    {"aspect": "symbols-reels", "title": "Symbols & Reels", "order": 3},
    {"aspect": "paytable", "title": "Paytable", "order": 4},
    {"aspect": "bonus-features", "title": "Bonus Features", "order": 5},
    {"aspect": "ui-ux", "title": "UI / UX & Layout", "order": 6},
    {"aspect": "audio", "title": "Audio", "order": 7},
]

GDD_TOOL_NAMES: set[str] = {
    "list_gdd_docs", "read_gdd_doc", "set_gdd_fields",
    "set_doc_status", "ask_user_question",
}


def gdd_wire(doc: GddDoc) -> dict:
    return doc.model_dump(by_alias=True, mode="json")


def derive_status(aspect: str, data: dict) -> Status:
    if not data:
        return "empty"
    schema = schema_for(aspect)
    missing = [
        f.key for f in schema
        if f.required and data.get(f.key) in (None, "", [], {})
    ]
    return "needs_input" if missing else "drafted"

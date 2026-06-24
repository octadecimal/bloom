from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

Status = Literal["empty", "drafted", "needs_input", "complete"]


class _WireModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class GddDoc(_WireModel):
    id: str
    game_id: str
    aspect: str
    title: str
    order: int
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
    "list_gdd_docs", "read_gdd_doc", "write_gdd_doc",
    "edit_gdd_doc", "set_doc_status", "ask_user_question",
}


def gdd_wire(doc: GddDoc) -> dict:
    return doc.model_dump(by_alias=True, mode="json")

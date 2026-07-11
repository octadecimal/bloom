from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class _WireModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class GameDefinitionDoc(_WireModel):
    id: str
    game_id: str
    definition: dict  # composed@1 GameDefinition, Rust serde wire shape (opaque here)
    presentation: dict = {}  # runtime presentation blob, embedded verbatim at build
    created_at: str
    updated_at: str


def compose_wire(doc: GameDefinitionDoc) -> dict:
    return doc.model_dump(by_alias=True, mode="json")

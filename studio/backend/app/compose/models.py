from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from app.math.models import (
    CurationParams, CurationResult, SectionLocks, TuneResult, TuningParams,
    default_params, default_tuning_params,
)


class _WireModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class GameDefinitionDoc(_WireModel):
    id: str
    game_id: str
    definition: dict  # composed@1 GameDefinition, Rust serde wire shape (opaque here)
    presentation: dict = {}  # runtime presentation blob, embedded verbatim at build
    # Folded math fields (spec §2 — no third collection). Same names/shapes as
    # SlotModelDoc so MathStore can present one view for both families.
    params: CurationParams = Field(default_factory=default_params)
    tuner_params: TuningParams = Field(default_factory=default_tuning_params)
    locks: SectionLocks = Field(default_factory=SectionLocks)
    result: CurationResult | None = None
    tune_result: TuneResult | None = None
    verdict_stale: bool = False
    created_at: str
    updated_at: str


def compose_wire(doc: GameDefinitionDoc) -> dict:
    # tune_result embeds the full GA trace + profile; the /tuner wire carries it
    # (tuner_view). Keep this wire slim — mirrors sim_wire.
    return doc.model_dump(by_alias=True, mode="json", exclude={"tune_result"})

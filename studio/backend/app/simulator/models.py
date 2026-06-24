from typing import Literal
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

class _WireModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

class CurationParams(_WireModel):
    pool_size: int
    candidate_count: int
    master_seed: int
    rtp_tolerance: float
    realized_correction_band: float
    bonus_rate_tolerance: float  # relative ± band around the GDD bonus rate

class MetricsWire(_WireModel):
    rtp: float
    volatility: float
    hit_frequency: float
    base_rtp: float
    feature_rtp: float
    bonus_hit_rates: list[float]

class CurationResult(_WireModel):
    status: Literal["pass", "fail", "error"]
    metrics: MetricsWire
    realized_rtp: float | None = None
    pool_size: int | None = None
    failure: str | None = None
    ran_at: str

class SlotModelDoc(_WireModel):
    id: str
    game_id: str
    model: dict
    params: CurationParams
    result: CurationResult | None = None
    created_at: str
    updated_at: str

def default_params() -> CurationParams:
    return CurationParams(
        pool_size=1_000,
        candidate_count=50_000,
        master_seed=2026,
        rtp_tolerance=0.01,
        realized_correction_band=0.05,
        bonus_rate_tolerance=0.25,
    )

def sim_wire(doc: SlotModelDoc) -> dict:
    return doc.model_dump(by_alias=True, mode="json")

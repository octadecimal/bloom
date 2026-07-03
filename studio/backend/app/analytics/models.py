from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel
from app.simulator.models import MetricsWire
from app.tuner.models import (
    TuningParams,
    GenSnapshotWire,
    PopulationStatsWire,
    HistogramBinWire,
    WinDistributionWire,
    TailWire,
    RtpPointWire,
    RunProfileWire,
)

__all__ = [
    "PopulationStatsWire",
    "HistogramBinWire",
    "WinDistributionWire",
    "TailWire",
    "RtpPointWire",
    "RunProfileWire",
    "MathRunDoc",
    "math_run_wire",
]


class _WireModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class MathRunDoc(_WireModel):
    id: str
    game_id: str
    params: TuningParams
    verdict: str | None = None
    metrics: MetricsWire | None = None
    trace: list[GenSnapshotWire] = Field(default_factory=list)
    profile: RunProfileWire | None = None
    created_at: str
    duration_ms: int | None = None


def math_run_wire(doc: MathRunDoc) -> dict:
    return doc.model_dump(by_alias=True, mode="json")

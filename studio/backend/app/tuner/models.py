from typing import Literal
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel
from app.simulator.models import MetricsWire


class _WireModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class TuneWeights(_WireModel):
    rtp: float
    volatility: float
    hit_rate: float


class TuningParams(_WireModel):
    # minimal (always shown in the UI)
    master_seed: int
    population: int
    max_generations: int
    search_candidate_count: int
    final_candidate_count: int
    # advanced (collapsible)
    elitism: int
    mutation_rate: float
    crossover_rate: float
    stagnation_window: int
    weights: TuneWeights


class BandMissWire(_WireModel):
    metric: str
    measured: float
    band_lo: float
    band_hi: float


class GenSnapshotWire(_WireModel):
    generation: int
    best_fitness: float
    best_rtp: float
    best_volatility: float


class TuneResult(_WireModel):
    status: Literal["pass", "near_miss", "error"]
    verdict: Literal["pass", "near_miss"] | None = None
    tuned_model: dict | None = None
    metrics: MetricsWire | None = None
    missed: list[BandMissWire] = Field(default_factory=list)
    trace: list[GenSnapshotWire] = Field(default_factory=list)
    failure: str | None = None
    ran_at: str


class TunerJobDoc(_WireModel):
    id: str
    game_id: str
    params: TuningParams
    result: TuneResult | None = None
    created_at: str
    updated_at: str


def default_tuning_params() -> TuningParams:
    return TuningParams(
        master_seed=2026,
        population=24,
        max_generations=40,
        search_candidate_count=20_000,
        final_candidate_count=200_000,
        elitism=2,
        mutation_rate=0.25,
        crossover_rate=0.9,
        stagnation_window=12,
        weights=TuneWeights(rtp=1.0, volatility=1.0, hit_rate=1.0),
    )


def tuner_wire(doc: TunerJobDoc) -> dict:
    return doc.model_dump(by_alias=True, mode="json")

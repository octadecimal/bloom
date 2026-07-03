from typing import Literal
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel
from app.simulator.models import MetricsWire

TUNER_TOOL_NAMES: set[str] = {
    "read_tuner_setup", "set_tuner_params", "tune_slot_model", "apply_tuned_model",
}


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


class PopulationStatsWire(_WireModel):
    min: float
    q1: float
    median: float
    q3: float
    max: float
    mean: float
    diversity: float


def _default_population_stats() -> "PopulationStatsWire":
    return PopulationStatsWire(min=0.0, q1=0.0, median=0.0, q3=0.0, max=0.0, mean=0.0, diversity=0.0)


class HistogramBinWire(_WireModel):
    bin_lo: float
    bin_hi: float
    base: int
    feature: int


class WinDistributionWire(_WireModel):
    bins: list[HistogramBinWire] = Field(default_factory=list)
    zero_count: int


class TailWire(_WireModel):
    max_win: float
    # Rust wire key is "pGE100x" (not the auto-camel "pGe100x") — explicit alias required.
    p_ge100x: float = Field(alias="pGE100x")
    p_losing_spin: float
    longest_dead_streak: int
    bonus_trigger_rate: float


class RtpPointWire(_WireModel):
    n: int
    realized_rtp: float


class RunProfileWire(_WireModel):
    distribution: WinDistributionWire
    tail: TailWire
    rtp_convergence: list[RtpPointWire] = Field(default_factory=list)


class GenSnapshotWire(_WireModel):
    generation: int
    best_fitness: float
    best_rtp: float
    best_volatility: float
    # Safe defaults: existing construction sites (e.g. runner.py's
    # parse_tune_result_line) don't yet populate these — Task 7 wires that up.
    population: PopulationStatsWire = Field(default_factory=_default_population_stats)
    gene_agreement: list[float] = Field(default_factory=list)


class TuneResult(_WireModel):
    status: Literal["pass", "near_miss", "error"]
    verdict: Literal["pass", "near_miss"] | None = None
    tuned_model: dict | None = None
    metrics: MetricsWire | None = None
    missed: list[BandMissWire] = Field(default_factory=list)
    trace: list[GenSnapshotWire] = Field(default_factory=list)
    profile: RunProfileWire | None = None
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

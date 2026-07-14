"""All math wire models: curation (was app/simulator/models.py), tuning (was
app/tuner/models.py), analytics runs (was app/analytics/models.py), plus the
unified SlotModelDoc (spec 2026-07-03-math-consolidation-design.md, sub-project 1)."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

TUNER_TOOL_NAMES: set[str] = {
    "read_tuner_setup", "set_tuner_params", "tune_slot_model", "apply_tuned_model",
}


class _WireModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


# ── curation (verbatim from app/simulator/models.py) ────────────────────────
class CurationParams(_WireModel):
    pool_size: int
    candidate_count: int
    master_seed: int
    rtp_tolerance: float
    realized_correction_band: float
    bonus_rate_tolerance: float  # relative ± band around the GDD bonus rate
    max_win_tolerance: float = 0.5  # relative ± band around the GDD max-win intent


class MetricSEWire(_WireModel):
    """Standard errors of the measured metrics (additive; None on results
    that predate noise-aware verdicts)."""
    rtp: float
    volatility: float
    bonus_hit_rates: list[float] = Field(default_factory=list)
    hit_frequency: float | None = None


class MetricsWire(_WireModel):
    rtp: float
    volatility: float
    hit_frequency: float
    base_rtp: float
    feature_rtp: float
    bonus_hit_rates: list[float]
    se: MetricSEWire | None = None
    # SP-A/SP-B wire additions (None on results that predate them / slots-only paths)
    max_win: float | None = None
    state_rtp: dict[str, float] | None = None
    state_visit_freq: dict[str, float] | None = None


class CurationResult(_WireModel):
    status: Literal["pass", "fail", "error"]
    metrics: MetricsWire
    realized_rtp: float | None = None
    pool_size: int | None = None
    failure: str | None = None
    ran_at: str


def default_params() -> CurationParams:
    return CurationParams(
        pool_size=1_000,
        candidate_count=50_000,
        master_seed=2026,
        rtp_tolerance=0.01,
        realized_correction_band=0.05,
        bonus_rate_tolerance=0.25,
    )


# ── tuning (verbatim from app/tuner/models.py) ──────────────────────────────
class TuneWeights(_WireModel):
    rtp: float
    volatility: float
    hit_rate: float
    hit_frequency: float = 1.0  # base-game hit-frequency band (Plan 2)


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
    # Python-only restart knob (spec 2026-07-06-auto-restart-tune-design.md):
    # whole-tune attempts, re-seeded from best-so-far with escalated mutation.
    # Never forwarded to the Rust binary (build_config enumerates its fields).
    max_attempts: int = Field(default=4, ge=1, le=10)


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
    # The Rust side's top histogram bin is open-ended (bin_hi = f64::INFINITY),
    # which serde_json can't encode and emits as JSON null. Carry that through as
    # None end-to-end rather than materializing math.inf, which would make
    # json.dumps(..., allow_nan=False) — as Starlette's JSONResponse does — raise.
    bin_hi: float | None = None
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
    # Why the GA loop ended: "feasible" | "stagnated" | "budget" (None on
    # cassettes/results that predate it).
    stop_reason: str | None = None
    # SP-C: family descriptor from the wire (None on cassettes that predate it).
    family: str | None = None
    ran_at: str


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


# ── NEW: section locks ───────────────────────────────────────────────────────
class SectionLocks(_WireModel):
    """Locks constrain automation (GA, apply-template), never humans.
    Stored from sub-project 1; enforced by the tuner in sub-project 2."""
    reels: bool = False
    paytable: bool = False
    bonus: bool = False


# ── auto-restart loop (spec 2026-07-06-auto-restart-tune-design.md) ──────────
class AttemptSummaryWire(_WireModel):
    """One restart-loop attempt, folded onto the recorded run."""
    attempt: int
    verdict: str | None = None       # "pass" | "near_miss" (None never recorded)
    stop_reason: str | None = None   # the GA's own stop: feasible/stagnated/budget
    miss_score: float = 0.0          # ranking/diagnosis only, never a verdict


# ── NEW: the unified per-game math document (collection `slot_models`) ───────
class SlotModelDoc(_WireModel):
    id: str
    game_id: str
    model: dict
    params: CurationParams
    tuner_params: TuningParams = Field(default_factory=default_tuning_params)
    locks: SectionLocks = Field(default_factory=SectionLocks)
    presentation: dict = {}  # editor-side symbol labels/colors; opaque here
    # provenance + staleness (spec 2026-07-09 §4/§5)
    origin: Literal["template", "realized"] = "template"
    touched: bool = False           # human PUT or tuner apply happened
    verdict_stale: bool = False     # result no longer describes the model/targets
    shape_stale: bool = False       # GDD shape != model (gated re-realize denied)
    result: CurationResult | None = None       # last curation of the STORED model
    tune_result: TuneResult | None = None      # last tune (tuned_model pending Apply)
    created_at: str
    updated_at: str


# ── analytics run doc (from app/analytics/models.py, + NEW verify field) ─────
class MathRunDoc(_WireModel):
    id: str
    game_id: str
    params: TuningParams
    verdict: str | None = None
    metrics: MetricsWire | None = None
    trace: list[GenSnapshotWire] = Field(default_factory=list)
    profile: RunProfileWire | None = None
    verify: CurationResult | None = None  # NEW: independent curate pass on the winner
    locks: SectionLocks | None = None  # SP3: lock set the run was tuned with
    stop_reason: str | None = None  # why the GA ended: feasible/stagnated/budget
    # Auto-restart telemetry (None on runs that predate the restart loop).
    attempts: list[AttemptSummaryWire] | None = None
    loop_stop: str | None = None  # pass | attempts_exhausted | not_improving | error
    # SP-C: family descriptor the run was tuned with (None on runs that predate it).
    family: str | None = None
    created_at: str
    duration_ms: int | None = None


# ── wire helpers ─────────────────────────────────────────────────────────────
def sim_wire(doc: SlotModelDoc) -> dict:
    # tune_result is carried by the /tuner wire (tuner_view); keep the editor
    # wire slim — a TuneResult embeds the full GA trace + profile.
    return doc.model_dump(by_alias=True, mode="json", exclude={"tune_result"})


def tuner_view(doc: SlotModelDoc) -> dict:
    """The legacy /games/{id}/tuner wire shape (was TunerJobDoc), synthesized
    from the unified doc so the existing tuner plugin keeps working unchanged."""
    return {
        "id": doc.id,
        "gameId": doc.game_id,
        "params": doc.tuner_params.model_dump(by_alias=True, mode="json"),
        "result": (doc.tune_result.model_dump(by_alias=True, mode="json")
                   if doc.tune_result is not None else None),
        "createdAt": doc.created_at,
        "updatedAt": doc.updated_at,
    }


def math_run_wire(doc: MathRunDoc) -> dict:
    return doc.model_dump(by_alias=True, mode="json")

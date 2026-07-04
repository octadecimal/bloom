"""One-shot: tune a template's seed model to its stated target and print the
tuned model JSON to stdout. The frozen output is pasted into
app/math/templates.py so a fresh game is born near-target (spec decision 5).

Usage (from studio/backend, cargo toolchain required):
    uv run python tools/freeze_template.py video-5x3 > video-5x3.tuned.json
    uv run python tools/freeze_template.py high-vol-5x4 paytable bonus > hv.tuned.json  # lock sections against the GA
"""
import asyncio
import json
import sys

from app.config import get_settings
from app.math import templates
from app.math.bounds import build_config, derive_bounds
from app.math.models import SectionLocks, default_tuning_params
from app.math.runners.tune import SubprocessTunerRunner

TEMPLATE_TARGETS: dict[str, dict] = {
    "classic-3x3": {
        "rtp_target": 0.96, "rtp_tolerance": 0.01,
        "volatility_min": 0.0, "volatility_max": 3.0,
        "bonus_hit_rate_bands": [],
        "pool_size": 1000, "candidate_count": 50_000,
        "realized_correction_band": 0.05, "master_seed": 2026,
    },
    "video-5x3": {
        "rtp_target": 0.96, "rtp_tolerance": 0.01,
        "volatility_min": 3.0, "volatility_max": 6.0,
        "bonus_hit_rate_bands": [{"min": (1 / 150) * 0.75, "max": (1 / 150) * 1.25}],
        "pool_size": 1000, "candidate_count": 50_000,
        "realized_correction_band": 0.05, "master_seed": 2026,
    },
    "high-vol-5x4": {
        "rtp_target": 0.96, "rtp_tolerance": 0.01,
        "volatility_min": 10.0, "volatility_max": 1e9,
        "bonus_hit_rate_bands": [{"min": (1 / 200) * 0.75, "max": (1 / 200) * 1.25}],
        "pool_size": 1000, "candidate_count": 50_000,
        "realized_correction_band": 0.05, "master_seed": 2026,
    },
}


async def main(name: str, lock_names: list[str]) -> None:
    seed = templates.get_model(name)
    target = TEMPLATE_TARGETS[name]
    params = default_tuning_params().model_copy(update={"max_generations": 160})
    locks = SectionLocks(**{n: True for n in lock_names})
    config = build_config(params, derive_bounds(seed), locks)
    runner = SubprocessTunerRunner(get_settings())

    def progress(p):
        print(f"gen {p.generation}/{p.max_generations} "
              f"fitness {p.best_fitness:.4f} rtp {p.best_rtp:.4f}", file=sys.stderr)

    result = await runner.run(seed, target, config, on_progress=progress)
    if result.status not in ("pass", "near_miss") or not result.tuned_model:
        raise SystemExit(f"tune failed: {result.status} {result.failure}")
    m = result.metrics
    print(f"verdict={result.verdict} rtp={m.rtp} vol={m.volatility} "
          f"hit={m.hit_frequency}", file=sys.stderr)
    print(json.dumps(result.tuned_model, indent=2))


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2:]))

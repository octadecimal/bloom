import json
import sys
from types import SimpleNamespace

import pytest

from app.math.runners.tune import SubprocessTunerRunner, TuneProgress, parse_tune_result_line


def _enriched_result_line() -> str:
    return json.dumps({
        "type": "result",
        "verdict": "pass",
        "model": {"reels": [[0, 1]]},
        "metrics": {
            "rtp": 0.9, "volatility": 2.0, "hitFrequency": 0.4,
            "baseRtp": 0.9, "featureRtp": 0.0, "bonusHitRates": [],
        },
        "missed": [],
        "trace": [{
            "generation": 0, "bestFitness": -0.5, "bestRtp": 0.5, "bestVolatility": 2.0,
            "population": {
                "min": -0.9, "q1": -0.7, "median": -0.5, "q3": -0.3,
                "max": -0.1, "mean": -0.5, "diversity": 0.4,
            },
            "geneAgreement": [0.8, 0.6],
        }],
        "profile": {
            "distribution": {
                "bins": [{"binLo": 5.0, "binHi": 10.0, "base": 3, "feature": 1}],
                "zeroCount": 7,
            },
            "tail": {
                "maxWin": 120.0, "pGE100x": 0.02, "pLosingSpin": 0.6,
                "longestDeadStreak": 9, "bonusTriggerRate": 0.05,
            },
            "rtpConvergence": [{"n": 1000, "realizedRtp": 0.95}],
        },
    })


def test_parse_result_maps_profile_block():
    result = parse_tune_result_line(_enriched_result_line(), ran_at="t")
    assert result.profile is not None
    assert result.profile.tail.p_ge100x == pytest.approx(0.02)
    assert result.profile.tail.max_win == pytest.approx(120.0)
    assert result.profile.distribution.bins[0].bin_lo == pytest.approx(5.0)
    assert result.profile.distribution.zero_count == 7
    assert result.profile.rtp_convergence[0].realized_rtp == pytest.approx(0.95)


def test_parse_result_maps_trace_population_and_gene_agreement():
    result = parse_tune_result_line(_enriched_result_line(), ran_at="t")
    assert result.trace[0].population.diversity == pytest.approx(0.4)
    assert result.trace[0].population.median == pytest.approx(-0.5)
    assert result.trace[0].gene_agreement == [0.8, 0.6]


def test_parse_result_without_profile_or_population_still_parses():
    # Backward-compat: an older cassette without the enriched fields shouldn't blow up;
    # pydantic defaults (empty profile=None, zeroed population) should kick in.
    line = json.dumps({
        "type": "result",
        "verdict": "pass",
        "model": {"reels": [[0]]},
        "metrics": {
            "rtp": 0.9, "volatility": 2.0, "hitFrequency": 0.4,
            "baseRtp": 0.9, "featureRtp": 0.0, "bonusHitRates": [],
        },
        "missed": [],
        "trace": [{"generation": 0, "bestFitness": -0.5, "bestRtp": 0.5, "bestVolatility": 2.0}],
    })
    result = parse_tune_result_line(line, ran_at="t")
    assert result.profile is None
    assert result.trace[0].population.diversity == pytest.approx(0.0)
    assert result.trace[0].gene_agreement == []


def _result_line_with_open_top_bin() -> str:
    # The Rust distribution histogram's top bin is open-ended (bin_hi =
    # f64::INFINITY). serde_json can't encode Infinity, so it emits JSON `null`
    # for that field — real subprocess output does this (see
    # bloom-simulator's log_bins()). A closed bin precedes it.
    return json.dumps({
        "type": "result",
        "verdict": "pass",
        "model": {"reels": [[0]]},
        "metrics": {
            "rtp": 0.9, "volatility": 2.0, "hitFrequency": 0.4,
            "baseRtp": 0.9, "featureRtp": 0.0, "bonusHitRates": [],
        },
        "missed": [],
        "trace": [],
        "profile": {
            "distribution": {
                "bins": [
                    {"binLo": 1000.0, "binHi": 2000.0, "base": 2, "feature": 0},
                    {"binLo": 2000.0, "binHi": None, "base": 1, "feature": 0},
                ],
                "zeroCount": 0,
            },
            "tail": {
                "maxWin": 3000.0, "pGE100x": 0.01, "pLosingSpin": 0.5,
                "longestDeadStreak": 3, "bonusTriggerRate": 0.02,
            },
            "rtpConvergence": [],
        },
    })


def test_parse_result_keeps_open_top_bin_as_none():
    result = parse_tune_result_line(_result_line_with_open_top_bin(), ran_at="t")
    bins = result.profile.distribution.bins
    # A normal (closed) bin keeps its float upper edge.
    assert bins[0].bin_hi == pytest.approx(2000.0)
    # The open-ended top bin is carried as None, NOT math.inf.
    assert bins[-1].bin_hi is None


def test_parsed_result_is_json_safe_the_way_rest_serializes_it():
    # REGRESSION: the REST routes dump TuneResult via Starlette's JSONResponse,
    # whose .render() does json.dumps(..., allow_nan=False). A materialized
    # math.inf for the open top bin makes that raise ValueError -> unhandled 500
    # on the first read after any real tune. Carrying the edge as None keeps it
    # JSON-compliant.
    result = parse_tune_result_line(_result_line_with_open_top_bin(), ran_at="t")
    # by_alias=True mirrors how the REST layer serializes (tuner_wire / MathRunDoc
    # both dump by_alias) — camelCase keys, JSON-mode values.
    wire = result.model_dump(mode="json", by_alias=True)
    json.dumps(wire, allow_nan=False)  # must NOT raise
    assert wire["profile"]["distribution"]["bins"][-1]["binHi"] is None


def _emit_script(*lines: str) -> str:
    # Tiny stand-in for the tune_json binary: print the given NDJSON lines.
    body = "\n".join(f"print({line!r})" for line in lines)
    return body


@pytest.mark.asyncio
async def test_drain_stdout_builds_progress_population_and_gene_agreement():
    # Drive the real _drain_stdout progress branch: feed a fake NDJSON progress
    # line (with population + geneAgreement) plus a minimal result line, and
    # assert the on_progress callback got concrete values (not just presence).
    progress = json.dumps({
        "type": "progress",
        "generation": 3, "maxGenerations": 40,
        "bestFitness": -0.25, "bestRtp": 0.85, "bestVolatility": 2.1,
        "population": {
            "min": -0.9, "q1": -0.7, "median": -0.5, "q3": -0.3,
            "max": -0.1, "mean": -0.5, "diversity": 0.42,
        },
        "geneAgreement": [0.8, 0.6],
    })
    result = json.dumps({
        "type": "result", "verdict": "pass", "model": {"reels": [[0]]},
        "metrics": {"rtp": 0.9, "volatility": 2.0, "hitFrequency": 0.4,
                    "baseRtp": 0.9, "featureRtp": 0.0, "bonusHitRates": []},
        "missed": [], "trace": [],
    })
    runner = SubprocessTunerRunner(SimpleNamespace(tuner_bin=""))
    runner._mem_cap_mb = 4096.0
    runner._timeout_s = 600.0
    runner._poll_s = 0.05
    runner._command = lambda *_a, **_k: [sys.executable, "-c", _emit_script(progress, result)]

    seen: list[TuneProgress] = []
    res = await runner.run({"m": 1}, {"t": 1}, {"c": 1}, on_progress=seen.append)

    assert res.status == "pass"
    assert len(seen) == 1
    assert seen[0].generation == 3
    assert seen[0].population.diversity == pytest.approx(0.42)
    assert seen[0].population.median == pytest.approx(-0.5)
    assert seen[0].gene_agreement == [0.8, 0.6]


def test_parse_tune_error_line_maps_message_to_failure():
    from app.math.runners.tune import parse_tune_error_line
    res = parse_tune_error_line(
        {"type": "error", "message": "everything is locked — nothing to tune"},
        ran_at="t")
    assert res.status == "error"
    assert res.verdict is None
    assert res.tuned_model is None
    assert "locked" in res.failure
    assert res.ran_at == "t"

import json

import pytest

from app.tuner.runner import parse_tune_result_line


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


def test_parse_result_maps_null_bin_hi_to_infinity():
    # The Rust distribution histogram's top bin is open-ended (bin_hi =
    # f64::INFINITY). serde_json can't encode Infinity, so it emits JSON `null`
    # for that field — real subprocess output does this (see
    # bloom-simulator's log_bins()). Confirm we recover math.inf, not a crash.
    line = json.dumps({
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
                "bins": [{"binLo": 2000.0, "binHi": None, "base": 1, "feature": 0}],
                "zeroCount": 0,
            },
            "tail": {
                "maxWin": 3000.0, "pGE100x": 0.01, "pLosingSpin": 0.5,
                "longestDeadStreak": 3, "bonusTriggerRate": 0.02,
            },
            "rtpConvergence": [],
        },
    })
    result = parse_tune_result_line(line, ran_at="t")
    assert result.profile.distribution.bins[0].bin_hi == float("inf")

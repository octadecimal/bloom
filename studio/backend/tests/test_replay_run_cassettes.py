# studio/backend/tests/test_replay_run_cassettes.py
import json
from types import SimpleNamespace

import pytest
from langchain_core.messages import HumanMessage

from app.replay.cassette import load_run_cassettes, normalize_prompt
from app.providers import ReplayToolCallingChatModel


def _write(root, name, data):
    run = root / "run"
    run.mkdir(parents=True, exist_ok=True)
    (run / name).write_text(json.dumps(data), encoding="utf-8")


def test_load_run_cassettes_keys_by_prompt_and_default(tmp_path):
    _write(tmp_path, "default.json", {"tool_calls": [{"name": "x", "args": {}}], "final": ["d"]})
    _write(tmp_path, "set.json", {
        "prompt": "Set the bonus hit rate to 1:200",
        "tool_calls": [{"name": "set_gdd_fields", "args": {"aspect": "math-model"}}],
        "final": ["ok"],
    })
    cass = load_run_cassettes(tmp_path)
    assert cass["__default__"]["final"] == ["d"]
    keyed = cass[normalize_prompt("set the bonus hit rate to 1:200")]
    assert keyed["tool_calls"][0]["name"] == "set_gdd_fields"


def _tool(name):
    return SimpleNamespace(name=name)


@pytest.mark.asyncio
async def test_tool_mode_selects_cassette_by_prompt():
    cass = {
        "__default__": {"tool_calls": [], "final": ["ok"]},
        normalize_prompt("set the bonus hit rate to 1:200"): {
            "tool_calls": [{"name": "set_gdd_fields",
                            "args": {"aspect": "math-model",
                                     "fields": {"bonus_hit_rate": "1:200"}}}],
            "final": ["Set it."],
        },
    }
    model = ReplayToolCallingChatModel(
        cassette=cass["__default__"], run_cassettes=cass, model="m"
    )
    model.bind_tools([_tool("set_gdd_fields"), _tool("ask_user_question")])
    res = await model._agenerate([HumanMessage("Set the bonus hit rate to 1:200")])
    tc = res.generations[0].message.tool_calls
    assert tc and tc[0]["name"] == "set_gdd_fields"
    assert tc[0]["args"]["fields"]["bonus_hit_rate"] == "1:200"


@pytest.mark.asyncio
async def test_round_with_no_bound_calls_raises_loudly():
    """A multi-round cassette round that becomes EMPTY after binding-filter must
    fail loudly, not return [] — an empty AIMessage would be read by the react
    agent as a final answer and silently swallow the remaining rounds."""
    cass = {
        "tool_call_rounds": [
            [{"name": "generate_asset", "args": {"slot": "background"}}],
        ],
        "final": ["done"],
    }
    model = ReplayToolCallingChatModel(cassette=cass, run_cassettes={}, model="m")
    model.bind_tools([_tool("add_sprite")])  # disjoint from the round's calls
    with pytest.raises(ValueError, match="no calls bound"):
        await model._agenerate([HumanMessage("make a scene")])


@pytest.mark.asyncio
async def test_tool_mode_unknown_prompt_falls_back_to_default():
    cass = {"__default__": {"tool_calls": [], "final": ["hi"]}}
    model = ReplayToolCallingChatModel(
        cassette=cass["__default__"], run_cassettes=cass, model="m"
    )
    model.bind_tools([_tool("set_gdd_fields")])
    res = await model._agenerate([HumanMessage("hello there")])
    msg = res.generations[0].message
    assert not msg.tool_calls and msg.content == "hi"

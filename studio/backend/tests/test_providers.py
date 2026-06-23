import pytest
from app.config import Settings
from app.providers import (
    ReplayLLMProvider, LiveOpenRouterProvider, build_provider, ERROR_SENTINEL_MODEL,
    ReplayToolCallingChatModel,
)

CASSETTES = {"hi there": ["Hi", " back"], "__default__": ["Sure", " thing"]}


async def _collect(provider, turns, model):
    return "".join([c async for c in provider.stream(turns, model)])


async def test_replay_returns_recorded_chunks_not_echo():
    p = ReplayLLMProvider(CASSETTES)
    out = await _collect(p, [{"role": "user", "content": "Hi there"}], "m")
    assert out == "Hi back"
    assert not out.startswith("echo:")


async def test_replay_falls_back_to_default():
    p = ReplayLLMProvider(CASSETTES)
    out = await _collect(p, [{"role": "user", "content": "unknown prompt"}], "m")
    assert out == "Sure thing"


async def test_replay_raises_on_sentinel_model():
    p = ReplayLLMProvider(CASSETTES)
    with pytest.raises(RuntimeError):
        await _collect(p, [{"role": "user", "content": "x"}], ERROR_SENTINEL_MODEL)


def test_factory_selects_by_mode():
    assert isinstance(build_provider(Settings(provider_mode="replay")), ReplayLLMProvider)
    assert isinstance(build_provider(Settings(provider_mode="live")), LiveOpenRouterProvider)


from langchain_core.messages import AIMessage, HumanMessage, ToolMessage


def _cassette():
    return {
        "tool_calls": [{"name": "generate_asset", "args": {"description": "a knight"}}],
        "final": ["Done ", "now."],
    }


async def test_replay_model_first_turn_emits_tool_call():
    m = ReplayToolCallingChatModel(cassette=_cassette())
    res = await m.ainvoke([HumanMessage("make a knight")])
    assert res.tool_calls and res.tool_calls[0]["name"] == "generate_asset"
    assert res.tool_calls[0]["args"] == {"description": "a knight"}


async def test_replay_model_after_tool_emits_final_text():
    m = ReplayToolCallingChatModel(cassette=_cassette())
    msgs = [
        HumanMessage("make a knight"),
        AIMessage("", tool_calls=[{"name": "generate_asset", "args": {"description": "a knight"}, "id": "c1"}]),
        ToolMessage("Generated.", tool_call_id="c1"),
    ]
    res = await m.ainvoke(msgs)
    assert res.tool_calls == [] and res.content == "Done now."


async def test_replay_tool_model_raises_on_sentinel_model_agenerate():
    m = ReplayToolCallingChatModel(cassette=_cassette(), model=ERROR_SENTINEL_MODEL)
    with pytest.raises(RuntimeError, match="sentinel model"):
        await m.ainvoke([HumanMessage("x")])


class _T:
    def __init__(self, name): self.name = name


async def test_bound_tools_filter_cassette_tool_calls():
    cassette = {
        "tool_calls": [
            {"name": "generate_asset", "args": {"description": "knight"}},
            {"name": "delete_asset", "args": {"asset_id": "a1"}},
        ],
        "final": ["ok"],
    }
    model = ReplayToolCallingChatModel(cassette=cassette)
    bound = model.bind_tools([_T("delete_asset")])
    result = await bound._agenerate([HumanMessage("go")])
    calls = result.generations[0].message.tool_calls
    assert [c["name"] for c in calls] == ["delete_asset"]

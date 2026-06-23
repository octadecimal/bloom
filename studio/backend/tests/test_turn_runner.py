from app.providers import ReplayToolCallingChatModel
from app.turn_runner import TurnRunner, StepStarted, StepCompleted, StepToken, RunFinished
from app.agent_tools import ToolContext


class FakeStore:
    async def create_asset(self, *a, **k):
        class A: id = "asset1"; name = "knight"
        return A()
    async def list_assets(self, g): return []


class FakeHub:
    async def generate_and_wait(self, g, a): return None


class OneToolFactory:
    def known_tool_names(self): return {"generate_asset"}
    def build(self, allowlist, ctx):
        from app.agent_tools import build_generate_asset_tool
        return [build_generate_asset_tool(ctx)] if "generate_asset" in allowlist else []


class FakeSkill:
    body = "Use generate_asset once."
    tools = ["generate_asset"]


async def test_run_emits_ordered_tool_then_final():
    cassette = {
        "tool_calls": [{"name": "generate_asset", "args": {"description": "a knight"}}],
        "final": ["Done ", "now."],
    }
    runner = TurnRunner(
        chat_model_factory=lambda model: ReplayToolCallingChatModel(cassette=cassette),
        tool_factory=OneToolFactory(),
    )
    ctx = ToolContext("r1", "g1", FakeStore(), FakeHub())
    events = [
        e async for e in runner.run(
            messages=[{"role": "user", "content": "make a knight"}],
            model="x", skill=FakeSkill(), args={"description": "a knight"}, ctx=ctx,
        )
    ]
    types = [(type(e).__name__, getattr(e, "type", None)) for e in events]
    assert ("StepStarted", "tool_call") in types
    assert ("StepStarted", "tool_result") in types
    assert ("StepStarted", "final") in types
    assert isinstance(events[-1], RunFinished) and events[-1].status == "completed"
    final_text = "".join(e.delta for e in events if isinstance(e, StepToken))
    assert "Done now." in final_text

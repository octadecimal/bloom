import pytest

from app.scene.critic import Critique, CritiqueEdit, CritiqueRequest, EditParams


def test_critique_parses_structured_edit_list():
    c = Critique(
        **{
            "done": False,
            "edits": [
                {
                    "target_handle": "captain",
                    "action": "scale",
                    "params": {"scale": 0.6},
                    "why": "dominates the reel area",
                }
            ],
        }
    )
    assert c.done is False
    assert len(c.edits) == 1
    edit = c.edits[0]
    assert edit.target_handle == "captain"
    assert edit.action == "scale"
    assert edit.params.scale == 0.6
    assert edit.params.x is None and edit.params.z is None
    assert edit.why == "dominates the reel area"


def test_critique_defaults_are_done_false_and_empty_edits():
    c = Critique()
    assert c.done is False
    assert c.edits == []


def test_critique_rejects_unknown_action():
    with pytest.raises(Exception):  # pydantic ValidationError
        CritiqueEdit(target_handle="logo", action="teleport", params={}, why="x")


def test_edit_params_accepts_all_four_levers():
    p = EditParams(x=100, y=50, scale=0.4, z=5)
    assert (p.x, p.y, p.scale, p.z) == (100, 50, 0.4, 5)


def test_critique_request_bundles_frame_and_context():
    req = CritiqueRequest(
        frame_png=b"\x89PNG...",
        scene={"nodes": []},
        target_handle="captain",
        window=["background", "logo", "captain"],
        theme="premium pirate slot",
        regen_budget_left=5,
        pass_index=1,
    )
    assert req.frame_png.startswith(b"\x89PNG")
    assert req.target_handle == "captain"
    assert req.window[-1] == "captain"
    assert req.regen_budget_left == 5
    assert req.pass_index == 1
    # frozen: reassignment is rejected
    with pytest.raises(Exception):
        req.pass_index = 2


def test_critique_request_defaults():
    req = CritiqueRequest(
        frame_png=b"", scene={}, target_handle="logo", window=["logo"]
    )
    assert req.theme == ""
    assert req.regen_budget_left == 0
    assert req.pass_index == 0


from app.replay.cassette import DEFAULT_FIXTURES_DIR, load_critic_cassettes
from app.scene.critic import ReplaySceneCritic


def _req(target, pass_index=0):
    return CritiqueRequest(
        frame_png=b"\x89PNG",
        scene={"nodes": []},
        target_handle=target,
        window=[target],
        pass_index=pass_index,
    )


def test_load_critic_cassettes_keys_by_target_and_default():
    cassettes = load_critic_cassettes(DEFAULT_FIXTURES_DIR)
    assert "captain" in cassettes  # from shrink-captain.json (target "captain")
    assert "__default__" in cassettes  # from default.json
    assert cassettes["captain"][0]["edits"][0]["action"] == "scale"


@pytest.mark.asyncio
async def test_replay_critic_returns_recorded_pass_zero():
    critic = ReplaySceneCritic(load_critic_cassettes(DEFAULT_FIXTURES_DIR))
    out = await critic.critique(_req("captain", pass_index=0))
    assert out.done is False
    assert out.edits[0].action == "scale"
    assert out.edits[0].params.scale == 0.6


@pytest.mark.asyncio
async def test_replay_critic_advances_to_pass_one_done():
    critic = ReplaySceneCritic(load_critic_cassettes(DEFAULT_FIXTURES_DIR))
    out = await critic.critique(_req("captain", pass_index=1))
    assert out.done is True
    assert out.edits == []


@pytest.mark.asyncio
async def test_replay_critic_out_of_range_pass_is_done():
    critic = ReplaySceneCritic(load_critic_cassettes(DEFAULT_FIXTURES_DIR))
    out = await critic.critique(_req("captain", pass_index=99))
    assert out.done is True
    assert out.edits == []


@pytest.mark.asyncio
async def test_replay_critic_unknown_target_falls_back_to_default():
    critic = ReplaySceneCritic(load_critic_cassettes(DEFAULT_FIXTURES_DIR))
    out = await critic.critique(_req("no-such-handle", pass_index=0))
    assert out.done is True  # default.json: single done pass
    assert out.edits == []


@pytest.mark.asyncio
async def test_replay_critic_raises_when_no_cassette_and_no_default():
    critic = ReplaySceneCritic({})  # neither keyed nor __default__
    with pytest.raises(RuntimeError, match="critic cassette"):
        await critic.critique(_req("captain"))


from langchain_core.messages import HumanMessage, SystemMessage

from app.config import Settings
from app.scene.critic import (
    LiveSceneCritic,
    build_critic_messages,
    build_scene_critic,
)


def test_critic_model_config_default():
    assert Settings().critic_model == "anthropic/claude-sonnet-4-6"


def test_factory_selects_replay_critic():
    critic = build_scene_critic(Settings(provider_mode="replay"))
    assert isinstance(critic, ReplaySceneCritic)


def test_factory_selects_live_critic():
    critic = build_scene_critic(Settings(provider_mode="live"))
    assert isinstance(critic, LiveSceneCritic)


def test_message_builder_embeds_png_as_data_url():
    req = CritiqueRequest(
        frame_png=b"\x89PNG\r\n\x1a\n", scene={"nodes": []},
        target_handle="captain", window=["background", "logo", "captain"],
        theme="premium pirate slot", regen_budget_left=3,
    )
    msgs = build_critic_messages(req)
    assert isinstance(msgs[0], SystemMessage)
    assert isinstance(msgs[1], HumanMessage)
    parts = msgs[1].content
    image_part = next(p for p in parts if p["type"] == "image_url")
    assert image_part["image_url"]["url"].startswith("data:image/png;base64,")


def test_message_builder_text_carries_window_target_and_budget():
    req = CritiqueRequest(
        frame_png=b"x", scene={"nodes": [{"handle": "logo"}]},
        target_handle="captain", window=["background", "logo", "captain"],
        theme="premium pirate slot", regen_budget_left=3,
    )
    text = next(
        p["text"] for p in build_critic_messages(req)[1].content if p["type"] == "text"
    )
    assert "captain" in text  # just-added target
    assert "logo" in text  # window member
    assert "3" in text  # regen budget left
    assert "premium pirate slot" in text  # theme


def test_critic_system_prompt_is_slot_aware():
    from app.scene.critic import CRITIC_SYSTEM_PROMPT

    low = CRITIC_SYSTEM_PROMPT.lower()
    assert "slot" in low  # slot-game context
    assert "transform" in low  # transform-first discipline
    assert "window" in low  # look-behind constraint


def test_critic_owns_hud_placement_and_fixes_occlusion():
    from app.scene.critic import CRITIC_SYSTEM_PROMPT

    low = CRITIC_SYSTEM_PROMPT.lower()
    # the judge must catch elements hidden behind / overlapping others in the frame
    assert "occlud" in low or "hidden" in low or "overlap" in low
    # HUD elements have NO fixed region — the judge positions them from the frame
    assert "hud" in low or "meter" in low
    assert "no" in low and ("planned region" in low or "fixed region" in low)


def test_critique_request_carries_edit_history_default_empty():
    req = CritiqueRequest(frame_png=b"", scene={}, target_handle="logo", window=["logo"])
    assert req.edit_history == {}


def test_message_builder_embeds_edit_history():
    req = CritiqueRequest(
        frame_png=b"x", scene={"nodes": []},
        target_handle="reel_frame", window=["reel_frame"],
        edit_history={"reel_frame": [{"action": "move", "params": {"y": 430}, "why": "down"}]},
    )
    text = next(
        p["text"] for p in build_critic_messages(req)[1].content if p["type"] == "text"
    )
    assert "edit_history" in text
    assert "430" in text


def test_critic_prompt_has_convergence_discipline():
    from app.scene.critic import CRITIC_SYSTEM_PROMPT
    low = CRITIC_SYSTEM_PROMPT.lower()
    assert "history" in low
    assert "undo" in low or "converge" in low


from app.scene.critic import CRITIC_SYSTEM_PROMPT


def test_critique_request_carries_plan():
    req = CritiqueRequest(
        frame_png=b"", scene={"elements": []}, target_handle="reels",
        window=["reels"], plan={"reels": {"role": "reels", "x": 640, "y": 396,
                                          "w": 794, "h": 432, "z": 20}},
    )
    assert req.plan["reels"]["w"] == 794


def test_messages_include_plan_region_for_target():
    req = CritiqueRequest(
        frame_png=b"\x89PNG", scene={"elements": []}, target_handle="reels",
        window=["reels"], plan={"reels": {"role": "reels", "x": 640, "y": 396,
                                          "w": 794, "h": 432, "z": 20}},
    )
    msgs = build_critic_messages(req)
    text = msgs[1].content[0]["text"]
    assert "plan" in text.lower()
    assert "794" in text   # the intended region is shown to the critic


def test_system_prompt_is_reconcile_to_plan():
    assert "plan" in CRITIC_SYSTEM_PROMPT.lower()
    assert "reconcile" in CRITIC_SYSTEM_PROMPT.lower()

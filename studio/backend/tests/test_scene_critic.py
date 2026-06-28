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

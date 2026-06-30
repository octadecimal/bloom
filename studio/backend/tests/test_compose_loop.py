import pytest

from app.scene.compose_loop import (
    BuildElement,
    ComposeBounds,
    ComposeResult,
    run_compose,
)
from app.scene.critic import Critique, CritiqueEdit, EditParams


class FakeDeps:
    """Scriptable ComposeDeps for unit-testing run_compose with no I/O.

    `placements` is the running list of placed handles (placement order).
    `script` maps a placed handle -> list of Critique (one per pass).
    `capture_fail` is a set of handles whose render_scene() raises (render-fail path).
    `asset_verdicts` maps a handle -> AssetVerdict (default: ok=True keep).
    Records adjust/regenerate calls for assertions.
    """

    def __init__(self, script, *, capture_fail=frozenset(), asset_verdicts=None):
        self._script = script
        self._capture_fail = capture_fail
        self.placements: list[str] = []
        self.adjusts: list[tuple[str, EditParams]] = []
        self.regens: list[str] = []
        self.renders = 0
        self.corrections = []
        raw = asset_verdicts or {}
        self.asset_verdicts = {
            h: (v if isinstance(v, list) else [v]) for h, v in raw.items()
        }

    async def place(self, element: BuildElement) -> str:
        self.placements.append(element.slot)
        return f"placed {element.slot}"

    async def placed_handles(self) -> list[str]:
        return list(self.placements)

    async def scene_context(self) -> dict:
        return {"elements": list(self.placements)}

    async def render_scene(self) -> bytes:
        self.renders += 1
        target = self.placements[-1]
        if target in self._capture_fail:   # reuse the set, now "render fail"
            raise RuntimeError("render failed")
        return b"\x89PNG-fake-frame"

    async def critique_asset(self, target_handle: str, attempt: int = 0):
        from app.scene.asset_critic import AssetVerdict
        seq = self.asset_verdicts.get(target_handle)
        if not seq:
            return AssetVerdict()
        return seq[min(attempt, len(seq) - 1)]

    async def critique(self, request) -> Critique:
        passes = self._script.get(request.target_handle, [])
        if request.pass_index >= len(passes):
            return Critique(done=True, edits=[])
        return passes[request.pass_index]

    async def adjust(self, handle: str, params: EditParams) -> str:
        self.adjusts.append((handle, params))
        return f"adjusted {handle}"

    async def regenerate(self, handle: str) -> str:
        self.regens.append(handle)
        return f"regenerated {handle}"

    async def out_of_frame(self):
        return list(getattr(self, "corrections", []))


def _el(slot: str) -> BuildElement:
    return BuildElement(slot=slot, description=f"a {slot}")


@pytest.mark.asyncio
async def test_places_every_element_in_order():
    deps = FakeDeps({})  # default critic => done on pass 0, no edits
    result = await run_compose([_el("background"), _el("logo")], "pirate", deps)
    assert deps.placements == ["background", "logo"]
    assert result.elements_placed == 2
    assert result.edits_applied == 0


@pytest.mark.asyncio
async def test_applies_a_transform_then_stops_on_done():
    script = {
        "logo": [
            Critique(edits=[CritiqueEdit(
                target_handle="logo", action="scale",
                params=EditParams(scale=0.6), why="too big")]),
            Critique(done=True),
        ]
    }
    deps = FakeDeps(script)
    result = await run_compose([_el("logo")], "pirate", deps)
    assert deps.adjusts == [("logo", EditParams(scale=0.6))]
    assert result.edits_applied == 1
    assert result.passes == 2  # pass 0 edited, pass 1 returned done


@pytest.mark.asyncio
async def test_respects_max_passes_when_critic_never_says_done():
    # critic always returns an in-window edit and never `done`
    forever = [Critique(edits=[CritiqueEdit(
        target_handle="logo", action="move",
        params=EditParams(x=10, y=10), why="nudge")]) for _ in range(10)]
    deps = FakeDeps({"logo": forever})
    result = await run_compose(
        [_el("logo")], "pirate", deps, ComposeBounds(max_passes=3))
    assert result.passes == 3  # capped
    assert result.edits_applied == 3


@pytest.mark.asyncio
async def test_rejects_edits_outside_the_look_behind_window():
    # place 5 elements; while editing e4, target e0 (3 behind the window of 4)
    els = [_el(f"e{i}") for i in range(5)]
    script = {
        "e4": [
            Critique(edits=[CritiqueEdit(
                target_handle="e0", action="move",
                params=EditParams(x=1, y=1), why="out of window")]),
            Critique(done=True),
        ]
    }
    deps = FakeDeps(script)
    result = await run_compose(els, "pirate", deps, ComposeBounds(look_behind=3))
    assert deps.adjusts == []          # e0 is outside [e1..e4]
    assert result.rejected == 1
    assert result.edits_applied == 0


@pytest.mark.asyncio
async def test_regenerate_edits_are_capped_by_the_budget():
    script = {
        "a": [Critique(edits=[CritiqueEdit(
            target_handle="a", action="regenerate", why="wrong for role")]),
            Critique(done=True)],
        "b": [Critique(edits=[CritiqueEdit(
            target_handle="b", action="regenerate", why="wrong for role")]),
            Critique(done=True)],
    }
    deps = FakeDeps(script)
    result = await run_compose(
        [_el("a"), _el("b")], "pirate", deps, ComposeBounds(regen_budget=1))
    assert deps.regens == ["a"]        # only the first regenerate is funded
    assert result.regens_spent == 1
    assert result.rejected == 1        # b's regenerate refused (budget exhausted)


@pytest.mark.asyncio
async def test_render_failure_skips_critique_with_visible_note():
    script = {"logo": [Critique(edits=[CritiqueEdit(
        target_handle="logo", action="scale",
        params=EditParams(scale=0.5), why="x")])]}
    deps = FakeDeps(script, capture_fail={"logo"})
    result = await run_compose([_el("logo")], "pirate", deps)
    assert deps.adjusts == []          # never critiqued — render failed
    assert result.passes == 0
    assert deps.renders == 1           # tried once, failed, moved on
    assert any("could not render" in n for n in result.notes)  # fail-loud


@pytest.mark.asyncio
async def test_bad_asset_regenerates_then_converges_on_rejudge():
    from app.scene.asset_critic import AssetVerdict
    deps = FakeDeps(
        {"logo": [Critique(done=True)]},
        asset_verdicts={"logo": [
            AssetVerdict(ok=False, action="regenerate", reason="garbled text"),
            AssetVerdict(ok=True, action="keep", reason="fixed"),
        ]},
    )
    result = await run_compose([_el("logo")], "pirate", deps)
    assert deps.regens == ["logo"]              # regenerated exactly once
    assert result.assets_regenerated == 1
    assert any("asset ok" in n for n in result.notes)   # converged


@pytest.mark.asyncio
async def test_bad_asset_rejudge_is_bounded_by_retries():
    from app.scene.asset_critic import AssetVerdict
    deps = FakeDeps(
        {"logo": [Critique(done=True)]},
        asset_verdicts={"logo": [AssetVerdict(ok=False, action="regenerate", reason="still bad")]},
    )  # single verdict => always regenerate
    result = await run_compose(
        [_el("logo")], "pirate", deps, ComposeBounds(asset_regen_retries=2, regen_budget=5))
    assert deps.regens == ["logo", "logo"]      # capped at asset_regen_retries
    assert result.assets_regenerated == 2
    assert any("retries exhausted" in n for n in result.notes)


@pytest.mark.asyncio
async def test_bad_asset_rejudge_respects_shared_budget():
    from app.scene.asset_critic import AssetVerdict
    deps = FakeDeps(
        {"a": [Critique(done=True)], "b": [Critique(done=True)]},
        asset_verdicts={
            "a": [AssetVerdict(ok=False, action="regenerate", reason="bad a")],
            "b": [AssetVerdict(ok=False, action="regenerate", reason="bad b")],
        },
    )
    result = await run_compose(
        [_el("a"), _el("b")], "pirate", deps, ComposeBounds(regen_budget=1))
    assert deps.regens == ["a"]                 # only the first regen is funded
    assert result.assets_regenerated == 1
    assert any("budget exhausted" in n for n in result.notes)


@pytest.mark.asyncio
async def test_unloadable_asset_surfaces_visible_note_not_asset_ok():
    from app.scene.asset_critic import AssetVerdict
    deps = FakeDeps(
        {"logo": [Critique(done=True)]},
        asset_verdicts={"logo": AssetVerdict(ok=False, action="keep",
                                             reason="couldn't load asset image for review")},
    )
    result = await run_compose([_el("logo")], "pirate", deps)
    assert deps.regens == []
    assert any("couldn't load asset image for review" in n for n in result.notes)
    assert not any("logo: asset ok" in n for n in result.notes)


def test_bounds_and_result_have_new_quality_fields():
    b = ComposeBounds()
    assert b.asset_regen_retries == 2
    assert b.max_edits_per_element == 4
    # still the established defaults
    assert (b.look_behind, b.max_passes, b.regen_budget) == (3, 3, 5)
    assert ComposeResult().corrections_applied == 0


@pytest.mark.asyncio
async def test_edit_history_is_passed_to_the_critic():
    seen = {}

    class HistoryDeps(FakeDeps):
        async def critique(self, request):
            seen[request.pass_index] = dict(request.edit_history)
            return await super().critique(request)

    script = {"logo": [
        Critique(edits=[CritiqueEdit(target_handle="logo", action="move",
                                     params=EditParams(x=10, y=10), why="nudge")]),
        Critique(done=True),
    ]}
    deps = HistoryDeps(script)
    await run_compose([_el("logo")], "pirate", deps)
    assert seen[0] == {}                       # nothing applied yet on pass 0
    assert "logo" in seen[1]                    # pass 1 sees the pass-0 edit
    assert seen[1]["logo"][0]["action"] == "move"


@pytest.mark.asyncio
async def test_in_frame_guard_clamps_and_counts_separately():
    from app.scene.compose_loop import FrameCorrection
    deps = FakeDeps({"logo": [Critique(done=True)]})
    deps.corrections = [FrameCorrection(handle="logo", x=600, y=340,
                                        reason="logo spilled off the right edge")]
    result = await run_compose(
        [_el("logo")], "pirate", deps, ComposeBounds(max_edits_per_element=0))
    # applied via adjust, counted as a correction, NOT as a critic edit
    assert ("logo", EditParams(x=600, y=340)) in deps.adjusts
    assert result.corrections_applied == 1
    assert result.edits_applied == 0
    assert any("into frame" in n for n in result.notes)


@pytest.mark.asyncio
async def test_per_element_edit_cap_refuses_further_edits():
    forever = [Critique(edits=[CritiqueEdit(
        target_handle="logo", action="move",
        params=EditParams(x=1, y=1), why="churn")]) for _ in range(10)]
    deps = FakeDeps({"logo": forever})
    result = await run_compose(
        [_el("logo")], "pirate", deps,
        ComposeBounds(max_passes=5, max_edits_per_element=2))
    assert result.edits_applied == 2           # capped
    assert result.rejected >= 1
    assert any("edit cap" in n for n in result.notes)


# ---------------------------------------------------------------------------
# Task 8: plan-aware compose loop
# ---------------------------------------------------------------------------

from app.scene.asset_critic import AssetVerdict
from app.scene.critic import CritiqueRequest
from app.scene.layout.bind import GddIntent, bind


class _RecordingDeps:
    """Minimal ComposeDeps fake that records placed elements + critic requests."""

    def __init__(self):
        self.placed: list[BuildElement] = []
        self.requests: list[CritiqueRequest] = []

    async def place(self, element):
        self.placed.append(element)
        return "ok"

    async def placed_handles(self):
        return [e.slot or e.role for e in self.placed]

    async def scene_context(self):
        return {"elements": []}

    async def render_scene(self):
        return b"\x89PNG"

    async def critique_asset(self, target_handle, attempt=0):
        return AssetVerdict(ok=True, action="keep", reason="ok")

    async def critique(self, request):
        self.requests.append(request)
        return Critique(done=True, edits=[])

    async def adjust(self, handle, params):
        return "ok"

    async def regenerate(self, handle):
        return "ok"

    async def out_of_frame(self):
        return []


@pytest.mark.asyncio
async def test_loop_overwrites_geometry_from_plan():
    plan = bind(GddIntent(focal_emphasis="reels"))
    deps = _RecordingDeps()
    el = BuildElement(description="ornate reel frame", slot="reels", role="reels",
                      x=10, y=10, fit="none")   # agent-guessed coords, should be ignored
    await run_compose([el], "pirate", deps, plan=plan)
    placed = deps.placed[0]
    pr = plan.for_role("reels")
    assert (placed.x, placed.y) == (pr.x, pr.y)        # plan position, not (10,10)
    assert placed.fit == pr.fit
    assert (placed.region_w, placed.region_h) == (pr.region_w, pr.region_h)
    assert placed.z_index == pr.z


@pytest.mark.asyncio
async def test_loop_passes_plan_region_into_critique():
    plan = bind(GddIntent())
    deps = _RecordingDeps()
    el = BuildElement(description="x", slot="reels", role="reels")
    await run_compose([el], "pirate", deps, plan=plan)
    req = deps.requests[0]
    assert "reels" in req.plan
    assert req.plan["reels"]["w"] == plan.for_role("reels").region_w


@pytest.mark.asyncio
async def test_loop_without_plan_is_unchanged():
    deps = _RecordingDeps()
    el = BuildElement(description="x", slot="reels", role="reels", x=10, y=10)
    await run_compose([el], "pirate", deps)   # no plan -> agent coords preserved
    assert (deps.placed[0].x, deps.placed[0].y) == (10, 10)
    assert deps.requests[0].plan == {}


@pytest.mark.asyncio
async def test_plan_context_and_apply_agree_on_handle_role_resolution():
    """The handle the critic is keyed by (slot-or-role) and the role used to fetch
    its planned region must stay consistent between place and critique."""
    plan = bind(GddIntent())
    deps = _RecordingDeps()
    # slot and role differ: handle should be the slot, region resolved via role.
    el = BuildElement(description="x", slot="reel_frame", role="reels")
    await run_compose([el], "pirate", deps, plan=plan)
    placed = deps.placed[0]
    pr = plan.for_role("reels")
    assert (placed.x, placed.y) == (pr.x, pr.y)          # _apply_plan resolved via role
    assert "reel_frame" in deps.requests[0].plan          # _plan_context keyed by slot
    assert deps.requests[0].plan["reel_frame"]["w"] == pr.region_w

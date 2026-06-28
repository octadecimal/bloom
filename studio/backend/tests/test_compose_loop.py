import asyncio

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
    `capture_fail` is a set of handles whose capture() raises (no-frame path).
    Records adjust/regenerate calls for assertions.
    """

    def __init__(self, script, *, capture_fail=frozenset()):
        self._script = script
        self._capture_fail = capture_fail
        self.placements: list[str] = []
        self.adjusts: list[tuple[str, EditParams]] = []
        self.regens: list[str] = []
        self.captures = 0

    async def place(self, element: BuildElement) -> str:
        self.placements.append(element.slot)
        return f"placed {element.slot}"

    async def placed_handles(self) -> list[str]:
        return list(self.placements)

    async def scene_context(self) -> dict:
        return {"elements": list(self.placements)}

    async def capture(self) -> bytes:
        self.captures += 1
        target = self.placements[-1]
        if target in self._capture_fail:
            raise asyncio.TimeoutError()
        return b"\x89PNG-fake-frame"

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
async def test_capture_failure_skips_critique_for_that_element():
    script = {"logo": [Critique(edits=[CritiqueEdit(
        target_handle="logo", action="scale",
        params=EditParams(scale=0.5), why="x")])]}
    deps = FakeDeps(script, capture_fail={"logo"})
    result = await run_compose([_el("logo")], "pirate", deps)
    assert deps.adjusts == []          # never critiqued — no frame
    assert result.passes == 0
    assert deps.captures == 1          # tried once, failed, moved on

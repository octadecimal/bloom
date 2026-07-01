import asyncio

from app.scene.art_critic import ArtRegen, SceneArtRequest, SceneArtVerdict
from app.scene.asset_critic import AssetVerdict
from app.scene.compose_loop import (
    BuildElement, ComposeBounds, CritiqueRequest, EditParams, run_compose,
)
from app.scene.critic import Critique


class FakeDeps:
    """Minimal ComposeDeps: geometry converges immediately so tests focus on the
    art stage. ``frames`` is the queue capture_real_frame returns (None = no
    client). ``art`` is the list of verdicts art_grade returns per pass."""

    def __init__(self, frames, art_verdicts):
        self._frames = list(frames)
        self._art = list(art_verdicts)
        self.regenerated: list[str] = []
        self._art_calls = 0

    async def place(self, element): return element.slot or element.role
    async def placed_handles(self): return ["background", "logo"]
    async def scene_context(self): return {"elements": []}
    async def render_scene(self): return b"pillow"
    async def critique_asset(self, target_handle, attempt=0): return AssetVerdict()
    async def critique(self, request): return Critique(done=True, edits=[])
    async def adjust(self, handle, params): return handle
    async def regenerate(self, handle): self.regenerated.append(handle); return handle
    async def out_of_frame(self): return []
    async def capture_real_frame(self):
        return self._frames.pop(0) if self._frames else None
    async def art_grade(self, request: SceneArtRequest) -> SceneArtVerdict:
        v = self._art[min(self._art_calls, len(self._art) - 1)]
        self._art_calls += 1
        return v


def _elements():
    return [BuildElement(slot="background", role="background"),
            BuildElement(slot="logo", role="logo")]


def test_art_skipped_when_no_client():
    deps = FakeDeps(frames=[None], art_verdicts=[SceneArtVerdict(premium=True)])
    result = asyncio.run(run_compose(_elements(), "pirate slot", deps))
    assert result.art_passes_run == 0
    assert any("art grade skipped: no live client" in n for n in result.notes)
    assert deps.regenerated == []


def test_art_premium_short_circuits():
    deps = FakeDeps(frames=[b"real"],
                    art_verdicts=[SceneArtVerdict(premium=True, summary="great")])
    result = asyncio.run(run_compose(_elements(), "pirate slot", deps))
    assert result.art_passes_run == 1
    assert any("art: great" in n for n in result.notes)
    assert deps.regenerated == []


def test_art_regenerates_then_regrades():
    deps = FakeDeps(
        frames=[b"real1", b"real2"],
        art_verdicts=[
            SceneArtVerdict(premium=False, summary="logo washed out",
                            regenerate=[ArtRegen(target_handle="logo", why="glow")]),
            SceneArtVerdict(premium=True, summary="fixed"),
        ])
    result = asyncio.run(run_compose(_elements(), "pirate slot", deps))
    assert deps.regenerated == ["logo"]
    assert result.art_passes_run == 2
    assert result.regens_spent == 1


def test_art_regen_rejects_unknown_handle():
    deps = FakeDeps(
        frames=[b"real1", b"real2"],
        art_verdicts=[
            SceneArtVerdict(premium=False,
                            regenerate=[ArtRegen(target_handle="ghost", why="x")]),
            SceneArtVerdict(premium=True),
        ])
    result = asyncio.run(run_compose(_elements(), "pirate slot", deps))
    assert deps.regenerated == []
    assert result.rejected >= 1


def test_art_shares_regen_budget():
    # budget of 0 -> art cannot regenerate even when flagged
    deps = FakeDeps(
        frames=[b"real1"],
        art_verdicts=[SceneArtVerdict(
            premium=False, regenerate=[ArtRegen(target_handle="logo", why="x")])])
    bounds = ComposeBounds(regen_budget=0)
    result = asyncio.run(run_compose(_elements(), "pirate slot", deps, bounds=bounds))
    assert deps.regenerated == []
    assert any("budget exhausted" in n for n in result.notes)


def test_art_passes_bounded():
    # never returns premium -> stage stops at bounds.art_passes
    v = SceneArtVerdict(premium=False,
                        regenerate=[ArtRegen(target_handle="logo", why="x")])
    deps = FakeDeps(frames=[b"a", b"b", b"c", b"d"], art_verdicts=[v])
    bounds = ComposeBounds(art_passes=2, regen_budget=5)
    result = asyncio.run(run_compose(_elements(), "pirate slot", deps, bounds=bounds))
    assert result.art_passes_run == 2

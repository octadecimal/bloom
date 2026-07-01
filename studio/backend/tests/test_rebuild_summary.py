from app.scene.layout.bind import GddIntent, bind
from app.scene.rebuild_summary import summarize_rebuild


def test_summary_marks_moved_roles_and_lists_targets():
    plan = bind(GddIntent())
    reels = plan.for_role("reels")
    # reels currently far from its planned spot -> shows an arrow; logo omitted from current
    summary = summarize_rebuild(plan, {"reels": (10.0, 10.0)})
    assert "reels:" in summary
    assert "->" in summary                       # moved
    assert f"{reels.region_w}x{reels.region_h}" in summary


def test_summary_no_arrow_when_already_in_place():
    plan = bind(GddIntent())
    reels = plan.for_role("reels")
    summary = summarize_rebuild(plan, {"reels": (reels.x, reels.y)})
    assert "->" not in summary

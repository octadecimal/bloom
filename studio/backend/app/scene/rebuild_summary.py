"""A short human summary of what a rebuild will do, for the approval gate label.

Pure: takes the freshly-bound plan + the currently-placed role positions and
renders one clause per role. Marks a role that will move with an arrow so the
human can approve against a concrete change, not a blind 'rebuild?'.
"""
from app.scene.layout.plan import ScenePlan


def summarize_rebuild(plan: ScenePlan, current: dict[str, tuple[float, float]]) -> str:
    clauses: list[str] = []
    for role, pr in sorted(plan.roles.items()):
        target = f"({pr.x:g},{pr.y:g}) {pr.region_w}x{pr.region_h}"
        cur = current.get(role)
        if cur and (round(cur[0]) != round(pr.x) or round(cur[1]) != round(pr.y)):
            clauses.append(f"{role}: ({cur[0]:g},{cur[1]:g}) -> {target}")
        else:
            clauses.append(f"{role}: {target}")
    return "; ".join(clauses)

# studio/backend/tests/test_layout_bind.py
from app.scene.layout.template import TEMPLATE_VERSION, REELS, LOGO, FLOURISH_LEFT, FLOURISH_RIGHT
from app.scene.layout.bind import GddIntent, NoopRefiner, bind


def test_bind_landscape_default_has_canonical_roles_and_version():
    plan = bind(GddIntent(orientation="landscape"))
    assert plan.canvas == (1280, 720)
    assert plan.template_version == TEMPLATE_VERSION
    assert {REELS, LOGO} <= set(plan.roles)


def test_bind_portrait_selects_portrait_canvas():
    plan = bind(GddIntent(orientation="portrait"))
    assert plan.canvas == (720, 1280)


def test_focal_emphasis_reels_enlarges_reels_region():
    base = bind(GddIntent(focal_emphasis="balanced")).for_role(REELS)
    reels = bind(GddIntent(focal_emphasis="reels")).for_role(REELS)
    assert reels.region_w > base.region_w and reels.region_h > base.region_h


def test_framing_density_clean_drops_flourishes():
    clean = bind(GddIntent(framing_density="clean"))
    ornate = bind(GddIntent(framing_density="ornate"))
    assert FLOURISH_LEFT not in clean.roles and FLOURISH_RIGHT not in clean.roles
    assert FLOURISH_LEFT in ornate.roles and FLOURISH_RIGHT in ornate.roles


def test_role_snippet_attached_from_intent():
    plan = bind(GddIntent(role_snippets={"reels": "ornate gold reel frame"}))
    assert "ornate gold reel frame" in plan.for_role(REELS).prompt_snippet


def test_noop_refiner_leaves_plan_unchanged():
    intent = GddIntent()
    assert bind(intent, NoopRefiner()).roles.keys() == bind(intent).roles.keys()

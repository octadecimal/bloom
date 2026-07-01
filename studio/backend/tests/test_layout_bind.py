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
    assert bind(intent, refiner=NoopRefiner()).roles.keys() == bind(intent).roles.keys()


def test_focal_logo_enlarges_logo_region():
    base = bind(GddIntent(focal_emphasis="balanced")).for_role(LOGO)
    logo = bind(GddIntent(focal_emphasis="logo")).for_role(LOGO)
    assert logo.region_w > base.region_w and logo.region_h > base.region_h


def test_focal_reels_shrinks_flourishes():
    base = bind(GddIntent(focal_emphasis="balanced", framing_density="ornate"))
    reels = bind(GddIntent(focal_emphasis="reels", framing_density="ornate"))
    assert reels.for_role(FLOURISH_LEFT).region_w < base.for_role(FLOURISH_LEFT).region_w


def test_override_replaces_only_set_fields():
    base = bind(GddIntent()).for_role("reels")
    plan = bind(GddIntent(), overrides={"reels": {"x": 100.0, "region_w": 200}})
    r = plan.for_role("reels")
    assert (r.x, r.region_w) == (100.0, 200)
    # untouched fields fall through to the plan
    assert (r.y, r.region_h, r.anchor_x) == (base.y, base.region_h, base.anchor_x)


def test_override_accepts_role_aliases():
    plan = bind(GddIntent(), overrides={"reel_frame": {"y": 42.0}})
    assert plan.for_role("reels").y == 42.0


def test_override_is_clamped_to_canvas():
    # landscape canvas is 1280x720; out-of-range values clamp
    plan = bind(GddIntent(), overrides={"reels": {"x": 9999.0, "y": -50.0,
                                                  "region_w": 99999, "anchor_x": 5.0}})
    r = plan.for_role("reels")
    assert r.x == 1280.0 and r.y == 0.0
    assert r.region_w == 1280 and r.anchor_x == 1.0


def test_override_for_absent_role_is_ignored():
    # 'clean' density drops flourishes; an override for one is a no-op, not a crash
    plan = bind(GddIntent(framing_density="clean"),
                overrides={"flourish_left": {"x": 10.0}})
    assert plan.for_role("flourish_left") is None


def test_bind_without_overrides_is_unchanged():
    assert bind(GddIntent()).for_role("reels") == bind(GddIntent(), overrides=None).for_role("reels")
    assert bind(GddIntent()).for_role("reels") == bind(GddIntent(), overrides={}).for_role("reels")

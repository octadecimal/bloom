from app.assets.recipes import Profile, profile_for, build_asset_prompt


def test_hero_roles_upscale_and_standard_roles_do_not():
    # background, logo AND reels are hero roles (the reel frame is the paramount
    # element, so it earns the sharpness pass); spin/symbols stay standard.
    assert profile_for("background").upscale is True
    assert profile_for("logo").upscale is True
    assert profile_for("reels").upscale is True
    assert profile_for("spin").upscale is False


def test_reels_prompt_demands_a_complete_5x3_frame_not_a_bare_border():
    p = profile_for("reels")
    low = p.positive.lower()
    # must describe a full grid structure, not just "transparent center"
    assert "5" in low and "3" in low            # 5x3 / 5 columns x 3 rows
    assert "column" in low or "grid" in low
    assert "row" in low or "cell" in low


def test_logo_is_the_only_role_with_active_negatives_and_cfg_above_one():
    logo = profile_for("logo")
    assert logo.negative != "" and logo.cfg >= 2.0
    for role in ("background", "reels", "spin", "symbol_wild"):
        p = profile_for(role)
        assert p.cfg == 1.0
        assert p.negative == ""


def test_role_aliases_resolve_through_canonical_role():
    # "title"/"wordmark" alias to logo; "reel_frame" to reels
    assert profile_for("title") == profile_for("logo")
    assert profile_for("reel_frame") == profile_for("reels")


def test_unknown_role_falls_back_to_default_standard_profile():
    p = profile_for("nonsense_role")
    assert p.upscale is False and p.cfg == 1.0


def test_build_asset_prompt_folds_description_boilerplate_and_art_direction():
    out = build_asset_prompt(
        "logo", art_direction="rotting zombie flesh, toxic green",
        description='wordmark "AI SLOTS"')
    assert 'wordmark "AI SLOTS"' in out
    assert "rotting zombie flesh" in out
    # the logo profile's positive boilerplate is present
    assert "legible" in out.lower()


def test_build_asset_prompt_dedupes_and_skips_empty_parts():
    out = build_asset_prompt("background", art_direction="", description="a graveyard")
    assert out.startswith("a graveyard")
    assert ", ," not in out and not out.endswith(", ")


def test_transparent_generations_end_with_the_ground_directive():
    """Matte-bench finding: with no ground named, FLUX paints atmosphere
    (bokeh, vignettes) that the matting step then has to fight. Transparent
    generations must pin the ground explicitly — and last, so art direction
    cannot reintroduce a backdrop after it."""
    from app.assets.recipes import GROUND_DIRECTIVE

    out = build_asset_prompt(
        "spin", art_direction="neon jungle, mist", description="a spin button",
        transparent=True)
    assert out.endswith(GROUND_DIRECTIVE)
    assert "solid black background" in GROUND_DIRECTIVE


def test_opaque_generations_get_no_ground_directive():
    out = build_asset_prompt(
        "background", art_direction="neon jungle", description="a graveyard")
    assert "black background" not in out


def test_recipe_generation_passes_transparency_through():
    import asyncio
    from types import SimpleNamespace

    from app.agent_tools import _recipe_generation
    from app.assets.recipes import GROUND_DIRECTIVE

    ctx = SimpleNamespace(gdd_store=None)
    prompt, workflow, _ = asyncio.run(_recipe_generation(
        ctx, description="a gold coin", style="", role="symbol_wild",
        transparent=True))
    assert prompt.endswith(GROUND_DIRECTIVE)
    assert workflow == "dev-transparent"

    prompt, workflow, _ = asyncio.run(_recipe_generation(
        ctx, description="a graveyard", style="", role="background",
        transparent=False))
    assert GROUND_DIRECTIVE not in prompt
    assert workflow == "dev-opaque"


def test_reels_profile_cuts_cells_and_other_roles_do_not():
    assert profile_for("reels").cut_cells is True
    assert profile_for("reel_frame").cut_cells is True  # alias
    for role in ("background", "logo", "spin", "symbol_wild"):
        assert profile_for(role).cut_cells is False

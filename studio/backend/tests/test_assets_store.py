import pytest

from app.assets.store import AssetStore


async def _mk(store):
    return await store.create_asset(
        game_id="g1", name="Wild", prompt="a wild symbol",
        width=512, height=512, workflow="schnell-transparent",
    )


@pytest.mark.asyncio
async def test_create_defaults(mongo_db):
    store = AssetStore(mongo_db)
    asset = await _mk(store)
    assert asset.id and asset.game_id == "g1"
    assert asset.status == "idle"
    assert asset.generations == []
    assert asset.selected_generation_id is None
    assert asset.seed is None and asset.category is None


@pytest.mark.asyncio
async def test_list_by_game(mongo_db):
    store = AssetStore(mongo_db)
    a = await _mk(store)
    await store.create_asset(game_id="other", name="X", prompt="p", width=64, height=64, workflow="schnell-opaque")
    listed = await store.list_assets("g1")
    assert [x.id for x in listed] == [a.id]


@pytest.mark.asyncio
async def test_update_authoring_fields(mongo_db):
    store = AssetStore(mongo_db)
    a = await _mk(store)
    updated = await store.update_asset(a.id, prompt="new prompt", seed=42)
    assert updated.prompt == "new prompt" and updated.seed == 42


@pytest.mark.asyncio
async def test_add_generation_autoselects_first_and_sets_done(mongo_db):
    store = AssetStore(mongo_db)
    a = await _mk(store)
    after = await store.add_generation(a.id, gen_id="gen1", seed=7, image_ref="/media/g1/" + a.id + "/gen1.png")
    assert after.status == "done"
    assert [g.id for g in after.generations] == ["gen1"]
    assert after.selected_generation_id == "gen1"

    after2 = await store.add_generation(a.id, gen_id="gen2", seed=8, image_ref="/x/gen2.png")
    assert [g.id for g in after2.generations] == ["gen1", "gen2"]
    assert after2.selected_generation_id == "gen1"  # second does NOT auto-select


@pytest.mark.asyncio
async def test_select_generation_and_status(mongo_db):
    store = AssetStore(mongo_db)
    a = await _mk(store)
    await store.add_generation(a.id, "gen1", 7, "/a.png")
    await store.add_generation(a.id, "gen2", 8, "/b.png")
    sel = await store.select_generation(a.id, "gen2")
    assert sel.selected_generation_id == "gen2"

    await store.set_status(a.id, "error", error="boom")
    err = await store.get_asset(a.id)
    assert err.status == "error" and err.error == "boom"


@pytest.mark.asyncio
async def test_delete(mongo_db):
    store = AssetStore(mongo_db)
    a = await _mk(store)
    await store.delete_asset(a.id)
    assert await store.get_asset(a.id) is None


@pytest.mark.asyncio
async def test_create_asset_persists_params(mongo_db):
    from app.assets.models import GenParams
    store = AssetStore(mongo_db)
    a = await store.create_asset("g", "logo", "p", 64, 64, "dev-transparent",
                                 params=GenParams(steps=28, upscale=True))
    got = await store.get_asset(a.id)
    assert got.params.steps == 28 and got.params.upscale is True

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, field_validator
from pydantic.alias_generators import to_camel

from app.assets.models import asset_wire
from app.games import game_wire
from app.scene.rebind import rebind_asset_textures

router = APIRouter()

# Authoring fields a PATCH may explicitly set to null. The remaining authoring
# fields are non-nullable on the model, so a null for them is ignored rather than
# written (which would corrupt the asset).
NULLABLE_FIELDS = {"seed", "category"}


class CreateAssetBody(BaseModel):
    name: str
    prompt: str
    width: int
    height: int
    workflow: str
    seed: int | None = None
    category: str | None = None


class UpdateAssetBody(BaseModel):
    name: str | None = None
    prompt: str | None = None
    width: int | None = None
    height: int | None = None
    workflow: str | None = None
    seed: int | None = None
    category: str | None = None


class SelectBody(BaseModel):
    # Frontend sends {"generationId": ...}; accept that camelCase alias.
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    generation_id: str


class CreateGameBody(BaseModel):
    name: str

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("name must not be blank")
        return v.strip()


@router.get("/games")
async def list_games(request: Request) -> list[dict]:
    games = await request.app.state.game_store.list_games()
    return [game_wire(g) for g in games]


@router.post("/games", status_code=201)
async def create_game(body: CreateGameBody, request: Request) -> dict:
    game = await request.app.state.game_store.create_game(body.name)
    return game_wire(game)


@router.get("/games/{game_id}/assets")
async def list_assets(game_id: str, request: Request) -> list[dict]:
    assets = await request.app.state.asset_store.list_assets(game_id)
    return [asset_wire(a) for a in assets]


@router.post("/games/{game_id}/assets", status_code=201)
async def create_asset(game_id: str, body: CreateAssetBody, request: Request) -> dict:
    asset = await request.app.state.asset_store.create_asset(
        game_id=game_id, name=body.name, prompt=body.prompt,
        width=body.width, height=body.height, workflow=body.workflow,
        seed=body.seed, category=body.category,
    )
    return asset_wire(asset)


@router.patch("/assets/{asset_id}")
async def update_asset(asset_id: str, body: UpdateAssetBody, request: Request) -> dict:
    # exclude_unset keeps an explicit `null` (clear the field) while dropping omitted
    # fields (leave them as-is); we then refuse nulls for non-nullable fields.
    fields = body.model_dump(exclude_unset=True)
    fields = {k: v for k, v in fields.items() if v is not None or k in NULLABLE_FIELDS}
    asset = await request.app.state.asset_store.update_asset(asset_id, **fields)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset not found")
    return asset_wire(asset)


@router.delete("/assets/{asset_id}", status_code=204)
async def delete_asset(asset_id: str, request: Request) -> Response:
    await request.app.state.asset_store.delete_asset(asset_id)
    return Response(status_code=204)


@router.post("/assets/{asset_id}/select")
async def select_generation(asset_id: str, body: SelectBody, request: Request) -> dict:
    asset = await request.app.state.asset_store.select_generation(asset_id, body.generation_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset not found")
    await rebind_asset_textures(
        request.app.state.scene_store, request.app.state.scene_hub, asset.game_id, asset
    )
    return asset_wire(asset)

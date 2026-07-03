from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

Status = Literal["idle", "queued", "generating", "done", "error"]
Workflow = Literal["schnell-opaque", "schnell-transparent", "dev-transparent", "dev-opaque"]


class _WireModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class Generation(_WireModel):
    id: str
    seed: int
    image_ref: str
    created_at: datetime


class GenParams(_WireModel):
    negative: str = ""
    steps: Optional[int] = None
    guidance: Optional[float] = None
    cfg: Optional[float] = None
    upscale: bool = False


class Asset(_WireModel):
    id: str
    game_id: str
    name: str
    category: Optional[str] = None
    slot: Optional[str] = None
    prompt: str
    width: int
    height: int
    workflow: Workflow
    seed: Optional[int] = None
    params: Optional[GenParams] = None
    status: Status = "idle"
    generations: list[Generation] = Field(default_factory=list)
    selected_generation_id: Optional[str] = None
    error: Optional[str] = None


def asset_wire(asset: Asset) -> dict:
    return asset.model_dump(by_alias=True, mode="json")

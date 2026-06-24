from dataclasses import dataclass
from typing import Literal

FieldType = Literal["number", "percent", "ratio", "enum", "text", "table", "list"]
Role = Literal["param", "narrative"]


@dataclass(frozen=True)
class Column:
    key: str
    label: str


@dataclass(frozen=True)
class Field:
    key: str
    label: str
    type: FieldType
    role: Role
    required: bool = False
    default: object | None = None
    enum: tuple[str, ...] | None = None
    columns: tuple[Column, ...] | None = None
    help: str = ""


def _t(*pairs: tuple[str, str]) -> tuple[Column, ...]:
    return tuple(Column(k, l) for k, l in pairs)


ASPECT_SCHEMAS: dict[str, list[Field]] = {
    "theme": [
        Field("name", "Name", "text", "param", required=True),
        Field("setting", "Setting", "text", "param"),
        Field("tone", "Tone", "enum", "param",
              enum=("epic", "playful", "dark", "luxe", "mythic")),
        Field("target_audience", "Target audience", "text", "param"),
        Field("narrative_hook", "Narrative hook", "text", "narrative"),
        Field("art_direction", "Art direction", "text", "narrative"),
    ],
    "math-model": [
        Field("rtp", "RTP", "percent", "param", required=True),
        Field("volatility", "Volatility", "enum", "param", required=True,
              enum=("low", "medium", "medium-high", "high")),
        Field("reels", "Reels", "number", "param", default=5),
        Field("rows", "Rows", "number", "param", default=3),
        Field("paylines", "Paylines / ways", "text", "param"),
        Field("max_win", "Max win (x bet)", "number", "param"),
        Field("hit_frequency", "Hit frequency", "percent", "param"),
        Field("bonus_hit_rate", "Bonus hit rate", "ratio", "param", required=True),
        Field("bet_range", "Bet range", "text", "param"),
    ],
    "symbols-reels": [
        Field("symbols", "Symbols", "table", "param", required=True,
              columns=_t(("name", "Name"), ("kind", "Kind"), ("art_desc", "Art description"))),
        Field("reel_strips", "Reel strips", "table", "param",
              columns=_t(("reel", "Reel"), ("composition", "Composition"))),
        Field("wild_behavior", "Wild behavior", "text", "narrative"),
        Field("scatter_behavior", "Scatter behavior", "text", "narrative"),
    ],
    "paytable": [
        Field("payouts", "Payouts", "table", "param", required=True,
              columns=_t(("symbol", "Symbol"), ("3oak", "3 OAK"),
                         ("4oak", "4 OAK"), ("5oak", "5 OAK"))),
        Field("special_pays", "Special pays", "table", "param",
              columns=_t(("name", "Name"), ("award", "Award"))),
        Field("notes", "Notes", "text", "narrative"),
    ],
    "bonus-features": [
        Field("features", "Features", "table", "param", required=True,
              columns=_t(("name", "Name"), ("trigger", "Trigger"),
                         ("description", "Description"))),
        Field("free_spins", "Free spins", "table", "param",
              columns=_t(("trigger", "Trigger"), ("count", "Count"),
                         ("retrigger", "Retrigger"), ("multiplier", "Multiplier"))),
        Field("bonus_buy", "Bonus buy", "text", "param"),
    ],
    "ui-ux": [
        Field("layout", "Layout", "text", "narrative"),
        Field("key_screens", "Key screens", "list", "param"),
        Field("controls", "Controls", "text", "narrative"),
        Field("quick_spin", "Quick spin", "text", "param"),
        Field("autoplay", "Autoplay", "text", "param"),
    ],
    "audio": [
        Field("music_style", "Music style", "text", "param"),
        Field("sfx", "SFX", "list", "param"),
        Field("dynamic_audio", "Dynamic audio", "text", "narrative"),
    ],
}


def schema_for(aspect: str) -> list[Field]:
    return ASPECT_SCHEMAS[aspect]


def required_param_keys(aspect: str) -> list[str]:
    return [f.key for f in schema_for(aspect) if f.required]


def field_catalog() -> dict[str, list[dict]]:
    """Machine-readable catalog of every aspect's fields for the design router.

    Maps aspect -> ordered list of {key, label, type, role, required, enum}.
    Seeds the design-router prompt with the addressable design surface.
    """
    return {
        aspect: [
            {
                "key": f.key,
                "label": f.label,
                "type": f.type,
                "role": f.role,
                "required": f.required,
                "enum": list(f.enum) if f.enum else None,
            }
            for f in fields
        ]
        for aspect, fields in ASPECT_SCHEMAS.items()
    }

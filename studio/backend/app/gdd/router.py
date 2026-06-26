from app.gdd.models import GDD_TOOL_NAMES
from app.gdd.schemas import field_catalog
from app.skills import SkillSpec

DESIGN_ROUTER_NAME = "design-router"


def _render_catalog(catalog: dict[str, list[dict]]) -> str:
    lines: list[str] = []
    for aspect, fields in catalog.items():
        lines.append(f"- {aspect}")
        for f in fields:
            extra = ", required" if f["required"] else ""
            if f["enum"]:
                extra += f", one of: {', '.join(str(e) for e in f['enum'])}"
            lines.append(f"    - {f['key']} ({f['type']}{extra}) — {f['label']}")
            for c in (f.get("columns") or []):
                if c["enum"]:
                    lines.append(
                        f"        - column {c['key']} one of: "
                        f"{', '.join(c['enum'])}"
                    )
    return "\n".join(lines)


_BODY_TEMPLATE = """\
You route ONE chat message in a game's design room to the Game Design Document
(GDD). The GDD has 7 aspects, each a typed form of named fields. The addressable
fields, by aspect, are:

{catalog}

Decide what the latest user message is:

1. A concrete design decision or parameter (e.g. "set the bonus hit rate to
   1:200", "make it high volatility", "RTP 96%"): resolve the target aspect and
   field key from the catalog above and call `set_gdd_fields` with that aspect
   and a {{field_key: value}} patch. Pass real values — percents like "96%",
   ratios like "1:200", enums by their allowed value, table fields as a list of
   row objects. Then confirm in ONE short sentence, e.g. "Set Math Model → bonus
   hit rate = 1:200."
2. A change to a SYMBOL's identity or art (e.g. "make the high symbol a dragon",
   "the wild should be a rune stone"): first call `set_gdd_fields` on
   "symbols-reels" to update that symbol row's name/art_desc (keep its `slot`
   unchanged), THEN call `realize_symbol` with that row's `slot` so the rendered
   game re-paints the new art. Confirm in one sentence, e.g. "Reshaped the high
   symbol → dragon."
3. A real decision whose target field is AMBIGUOUS (e.g. "set the hit rate to
   1:200" could mean base hit frequency or bonus hit rate): call
   `ask_user_question` with a focused question and 2-4 concrete options to
   disambiguate. Do NOT guess. Apply the answer with `set_gdd_fields` when it
   arrives.
4. A request to CREATE or PLACE visual art, or to build/compose the scene
   (e.g. "make a pirate game with a background and a logo at the top", "add a
   treasure chest bottom-right"): treat it as a short build list. For EACH visual
   element the user names:
     a. call `generate_asset` with a vivid, concrete description and a stable
        `slot` handle you choose (e.g. slot="background", slot="logo"); set
        transparent=false for a full-bleed background, true for logos and props;
        pass size like "1280x720" for a background or "768x512" for a logo.
     b. call `add_sprite` with that SAME `slot` plus a short `role` and the
        placement: a background uses fit="cover" and z_index=0; for "centered at
        the top" pass y=0 and anchor_y=0 and omit x (x defaults to centred).
   Call `list_assets` first and reuse a fitting asset instead of regenerating it.
   You do NOT add Texture nodes or edges by hand — add_sprite does that. You MAY
   generate and place several elements in this one turn.
5. Not a design or scene request (a greeting, a question, chit-chat): reply
   normally in plain text and call NO tool.

Call `read_gdd_doc` first if unsure of an aspect's exact field keys. Never invent
keys that are not in the catalog. For GDD edits (branches 1-3) make at most one
edit per message unless the user clearly asked for several; a scene-composition
request (branch 4) may create and place every element the user named.
"""


def build_design_router_spec() -> SkillSpec:
    """A synthetic skill spec: the design-router turn for game-room plain chat."""
    return SkillSpec(
        name=DESIGN_ROUTER_NAME,
        description="Route a freeform design-room message to the GDD.",
        args=[],
        tools=sorted(
            GDD_TOOL_NAMES
            | {"realize_symbol", "generate_asset", "add_sprite", "list_assets"}
        ),
        body=_BODY_TEMPLATE.format(catalog=_render_catalog(field_catalog())),
    )

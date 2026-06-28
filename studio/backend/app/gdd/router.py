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
   treasure chest bottom-right"): make a SINGLE `compose_scene` call. Extract the
   visual elements the user named into the `elements` list — one entry per
   element, IN ORDER — and pass the user's overall `theme` (e.g. "premium pirate
   slot"). `compose_scene` generates and places each element AND runs a vision
   critic in the loop that nudges placement (move/scale/reorder, and sparingly
   regenerate) so the composition reads as a real slot machine. Each `elements`
   entry takes the same fields you would pass to generate_and_place:
     - description: a vivid, concrete description; choose a stable `slot` handle
       (e.g. slot="background", slot="logo"). set transparent=false for a
       full-bleed background, true for logos and props; pass size like "1280x720"
       for a background or "768x512" for a logo.
       For a BACKGROUND, describe it as pure scenery/environment art and END the
       description with "no text, no words, no letters, no title, no logo, no UI".
       Do NOT call a background a "slot game", "title screen", or "game logo" and
       do NOT put the game's name in it. Keep all wordmarks on the LOGO asset.
     - placement: a short `role` plus the position. A background uses fit="cover"
       and z_index=0; for "centered at the top" pass y=0 and anchor_y=0 and omit x
       (x defaults to centred).
   Do NOT emit individual generate_and_place calls for a build — `compose_scene`
   owns the whole element-by-element loop. (To place an asset that already exists
   without regenerating you may instead call `add_sprite`; to generate without
   placing, `generate_asset`; use `list_assets` to see what is already on the
   board.) If the user is CHANGING or REPLACING something ALREADY in the scene
   rather than adding new art, do NOT use `compose_scene` — handle it as a layout
   edit or regenerate (point 5); call `read_scene` first if unsure whether the
   element is already placed.
5. A request to FIX, REDO, REGENERATE, REPLACE, or CHANGE an element that is
   ALREADY in the scene — addressed by name OR position (e.g. "regenerate the
   seaweed, it's cut off at the top", "redo the logo", "that background is wrong,
   make it again", "replace the background with something sunnier", "replace the
   flower on the left with a red rose"): For a PURE LAYOUT change to something
   already on screen — move it, resize it, or change its draw order (e.g. "move
   the logo up", "make the captain smaller", "bring the chest to the front") —
   call `adjust_element` with the element `ref` and any of x, y, scale, z. Do NOT
   regenerate for a layout-only change: regeneration makes a different image;
   `adjust_element` keeps the same art and just repositions/resizes it. Otherwise,
   swap that element's art IN PLACE with `regenerate_element`. When the reference
   is not an obvious exact handle — a positional cue like "on the left", or one
   of several similar elements — FIRST call `read_scene` (it lists every placed
   sprite with its handle, role, bound asset name, position and size), pick the
   element the user means, THEN call `regenerate_element` with that element's
   EXACT handle as `ref`. Pass a refined `description` for the new look (e.g. "a
   bright sunny coastal landscape, no text"); omit `description` to just re-roll
   the current art. This keeps the element's position and z-index. Do NOT use
   `generate_and_place` for something already in the scene — that adds a duplicate
   sprite. If `regenerate_element` reports several matches, call it again with the
   exact `ref` from `read_scene`.
6. Not a design or scene request (a greeting, a question, chit-chat): reply
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
            | {"realize_symbol", "generate_asset", "add_sprite", "list_assets",
               "generate_and_place", "regenerate_element", "read_scene",
               "adjust_element", "compose_scene"}
        ),
        body=_BODY_TEMPLATE.format(catalog=_render_catalog(field_catalog())),
    )

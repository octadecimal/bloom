NODE_TYPES = ("Root", "Container", "Sprite", "Texture")
EDGE_TYPES = ("child", "data")

SCENE_TOOL_NAMES: set[str] = {
    "scene_add_node", "scene_set_prop", "scene_connect",
    "scene_disconnect", "scene_remove_node", "scene_apply_batch",
}


class OpError(Exception):
    """A scene op was rejected; the model is left untouched. Mirrors the
    engine's TS OpError (runtime/client/src/model/ops.ts)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def empty_document() -> dict:
    return {"version": 1, "nodes": {}, "edges": [], "modules": []}


def unreachable_nodes(document: dict) -> list[str]:
    """Sprite/Container ids with no child-path to a Root. Textures never count
    (data-only nodes, no display object)."""
    nodes = document["nodes"]
    edges = document["edges"]
    reached: set[str] = set()
    frontier: list[str] = []
    for nid, n in nodes.items():
        if n["type"] == "Root":
            reached.add(nid)
            frontier.append(nid)
    while frontier:
        parent = frontier.pop()
        for e in edges:
            if e["type"] == "child" and e["from"]["node"] == parent and e["to"]["node"] not in reached:
                reached.add(e["to"]["node"])
                frontier.append(e["to"]["node"])
    return sorted(
        nid for nid, n in nodes.items()
        if n["type"] in ("Container", "Sprite") and nid not in reached
    )

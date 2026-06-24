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
    return {"version": 1, "nodes": {}, "edges": []}

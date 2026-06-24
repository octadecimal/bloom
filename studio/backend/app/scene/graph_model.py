from app.scene.document import NODE_TYPES, OpError


class GraphModel:
    """Pure, Mongo-free port of the engine's TS GraphModel
    (runtime/client/src/model/graphModel.ts) — same validation, no change
    records (the backend validates + persists; it does not reconcile Pixi)."""

    def __init__(self):
        self._nodes: dict[str, dict] = {}
        self._edges: dict[str, dict] = {}

    # --- read API ---
    def get_node(self, node_id: str) -> dict | None:
        return self._nodes.get(node_id)

    def to_document(self) -> dict:
        nodes = {
            nid: {"id": n["id"], "type": n["type"], "props": dict(n["props"])}
            for nid, n in self._nodes.items()
        }
        edges = [dict(e) for e in self._edges.values()]
        return {"version": 1, "nodes": nodes, "edges": edges}

    # --- write API ---
    def apply(self, op: dict) -> None:
        kind = op.get("kind")
        if kind == "addNode":
            return self._add_node(op["id"], op["type"], op.get("props"))
        if kind == "removeNode":
            return self._remove_node(op["id"])
        if kind == "setProp":
            return self._set_prop(op["id"], op["path"], op["value"])
        raise OpError("unknown_op", f"unknown op kind: {kind}")

    def _add_node(self, node_id: str, type_: str, props) -> None:
        if node_id in self._nodes:
            raise OpError("duplicate_id", f"node already exists: {node_id}")
        if type_ not in NODE_TYPES:
            raise OpError("bad_type", f"unknown node type: {type_}")
        self._nodes[node_id] = {"id": node_id, "type": type_, "props": dict(props or {})}

    def _remove_node(self, node_id: str) -> None:
        if node_id not in self._nodes:
            raise OpError("unknown_node", f"no such node: {node_id}")
        incident = [
            e for e in self._edges.values()
            if e["from"]["node"] == node_id or e["to"]["node"] == node_id
        ]
        for e in incident:
            del self._edges[e["id"]]
        del self._nodes[node_id]

    def _set_prop(self, node_id: str, path: str, value) -> None:
        node = self._nodes.get(node_id)
        if node is None:
            raise OpError("unknown_node", f"no such node: {node_id}")
        keys = path.split(".")
        cursor = node["props"]
        for k in keys[:-1]:
            if not isinstance(cursor.get(k), dict):
                cursor[k] = {}
            cursor = cursor[k]
        cursor[keys[-1]] = value

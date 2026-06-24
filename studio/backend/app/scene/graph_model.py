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

    def get_edge(self, edge_id: str) -> dict | None:
        return self._edges.get(edge_id)

    def edges_by_source(self, node_id: str, port: str | None = None) -> list[dict]:
        return [
            e for e in self._edges.values()
            if e["from"]["node"] == node_id and (port is None or e["from"]["port"] == port)
        ]

    def edges_by_target(self, node_id: str, port: str | None = None) -> list[dict]:
        return [
            e for e in self._edges.values()
            if e["to"]["node"] == node_id and (port is None or e["to"]["port"] == port)
        ]

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
        if kind == "connect":
            return self._connect(op["edgeId"], op["type"], op["from"], op["to"])
        if kind == "disconnect":
            return self._disconnect(op["edgeId"])
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

    def _connect(self, edge_id: str, type_: str, frm: dict, to: dict) -> None:
        if edge_id in self._edges:
            raise OpError("duplicate_edge", f"edge already exists: {edge_id}")
        if frm["node"] not in self._nodes:
            raise OpError("unknown_node", f"no such node: {frm['node']}")
        if to["node"] not in self._nodes:
            raise OpError("unknown_node", f"no such node: {to['node']}")
        if type_ == "child":
            child_id, parent_id = to["node"], frm["node"]
            if self._parent_of(child_id) is not None:
                raise OpError("already_parented", f"node already has a parent: {child_id}")
            if child_id == parent_id or self._is_ancestor(child_id, parent_id):
                raise OpError("cycle", "child edge would create a cycle")
        self._edges[edge_id] = {
            "id": edge_id, "type": type_, "from": dict(frm), "to": dict(to),
        }

    def _disconnect(self, edge_id: str) -> None:
        if edge_id not in self._edges:
            raise OpError("unknown_edge", f"no such edge: {edge_id}")
        del self._edges[edge_id]

    def _parent_of(self, child_id: str) -> str | None:
        for e in self._edges.values():
            if e["type"] == "child" and e["to"]["node"] == child_id:
                return e["from"]["node"]
        return None

    def _is_ancestor(self, maybe_ancestor: str, node: str) -> bool:
        cur: str | None = node
        while cur is not None:
            if cur == maybe_ancestor:
                return True
            cur = self._parent_of(cur)
        return False

    def apply_batch(self, ops: list[dict]) -> None:
        snapshot = self.to_document()
        try:
            for op in ops:
                self.apply(op)
        except Exception:
            self._restore(snapshot)
            raise

    def load(self, doc: dict) -> None:
        self._nodes.clear()
        self._edges.clear()
        ops: list[dict] = []
        for node in doc.get("nodes", {}).values():
            ops.append({"kind": "addNode", "id": node["id"], "type": node["type"],
                        "props": node.get("props") or {}})
        for e in doc.get("edges", []):
            ops.append({"kind": "connect", "edgeId": e["id"], "type": e["type"],
                        "from": e["from"], "to": e["to"]})
        self.apply_batch(ops)

    def _restore(self, doc: dict) -> None:
        self._nodes.clear()
        self._edges.clear()
        for node in doc["nodes"].values():
            self._nodes[node["id"]] = {"id": node["id"], "type": node["type"],
                                       "props": dict(node["props"])}
        for e in doc["edges"]:
            self._edges[e["id"]] = dict(e)

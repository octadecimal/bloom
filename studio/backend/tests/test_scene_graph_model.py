import pytest
from app.scene.graph_model import GraphModel
from app.scene.document import OpError


def test_add_node_then_read():
    m = GraphModel()
    m.apply({"kind": "addNode", "id": "s", "type": "Sprite", "props": {"alpha": 1}})
    assert m.get_node("s") == {"id": "s", "type": "Sprite", "props": {"alpha": 1}}


def test_add_node_defaults_props():
    m = GraphModel()
    m.apply({"kind": "addNode", "id": "root", "type": "Root"})
    assert m.get_node("root")["props"] == {}


def test_duplicate_id_rejected_without_mutation():
    m = GraphModel()
    m.apply({"kind": "addNode", "id": "x", "type": "Container"})
    with pytest.raises(OpError) as e:
        m.apply({"kind": "addNode", "id": "x", "type": "Sprite"})
    assert e.value.code == "duplicate_id"
    assert m.get_node("x")["type"] == "Container"


def test_unknown_type_rejected():
    m = GraphModel()
    with pytest.raises(OpError) as e:
        m.apply({"kind": "addNode", "id": "x", "type": "Nope"})
    assert e.value.code == "bad_type"


def test_remove_node():
    m = GraphModel()
    m.apply({"kind": "addNode", "id": "x", "type": "Sprite"})
    m.apply({"kind": "removeNode", "id": "x"})
    assert m.get_node("x") is None


def test_remove_unknown_rejected():
    m = GraphModel()
    with pytest.raises(OpError) as e:
        m.apply({"kind": "removeNode", "id": "ghost"})
    assert e.value.code == "unknown_node"


def test_set_prop_nested_creates_intermediate():
    m = GraphModel()
    m.apply({"kind": "addNode", "id": "s", "type": "Sprite"})
    m.apply({"kind": "setProp", "id": "s", "path": "position.x", "value": 240})
    assert m.get_node("s")["props"]["position"] == {"x": 240}


def test_set_prop_unknown_node_rejected():
    m = GraphModel()
    with pytest.raises(OpError) as e:
        m.apply({"kind": "setProp", "id": "ghost", "path": "alpha", "value": 1})
    assert e.value.code == "unknown_node"


def test_to_document_shape():
    m = GraphModel()
    m.apply({"kind": "addNode", "id": "x", "type": "Sprite"})
    assert m.to_document() == {
        "version": 1,
        "nodes": {"x": {"id": "x", "type": "Sprite", "props": {}}},
        "edges": [],
    }


def _with_nodes() -> GraphModel:
    m = GraphModel()
    m.apply({"kind": "addNode", "id": "root", "type": "Root"})
    m.apply({"kind": "addNode", "id": "box", "type": "Container"})
    m.apply({"kind": "addNode", "id": "s", "type": "Sprite"})
    m.apply({"kind": "addNode", "id": "tex", "type": "Texture", "props": {"src": "asset:1"}})
    return m


def _child(eid, parent, kid):
    return {"kind": "connect", "edgeId": eid, "type": "child",
            "from": {"node": parent, "port": "children"},
            "to": {"node": kid, "port": "parent"}}


def _data(eid, src, dst):
    return {"kind": "connect", "edgeId": eid, "type": "data",
            "from": {"node": src, "port": "data"},
            "to": {"node": dst, "port": "texture"}}


def test_child_connect_and_disconnect():
    m = _with_nodes()
    m.apply(_child("e1", "root", "box"))
    assert m.get_edge("e1")["type"] == "child"
    m.apply({"kind": "disconnect", "edgeId": "e1"})
    assert m.get_edge("e1") is None


def test_data_connect_read_helpers():
    m = _with_nodes()
    m.apply(_data("e2", "tex", "s"))
    assert [e["id"] for e in m.edges_by_source("tex", "data")] == ["e2"]
    assert [e["id"] for e in m.edges_by_target("s", "texture")] == ["e2"]


def test_edge_to_unknown_node_rejected():
    m = _with_nodes()
    with pytest.raises(OpError) as e:
        m.apply(_child("e1", "root", "ghost"))
    assert e.value.code == "unknown_node"


def test_duplicate_edge_id_rejected():
    m = _with_nodes()
    m.apply(_child("e1", "root", "box"))
    with pytest.raises(OpError) as e:
        m.apply(_child("e1", "box", "s"))
    assert e.value.code == "duplicate_edge"


def test_two_parents_rejected():
    m = _with_nodes()
    m.apply(_child("e1", "root", "s"))
    with pytest.raises(OpError) as e:
        m.apply(_child("e2", "box", "s"))
    assert e.value.code == "already_parented"


def test_cycle_rejected():
    from app.scene.document import OpError
    m = _wired()
    m.apply({"kind": "addNode", "id": "box2", "type": "Container"})
    m.apply({"kind": "connect", "edgeId": "e1", "type": "child",
             "from": {"node": "box", "port": "children"}, "to": {"node": "box2", "port": "parent"}})
    with pytest.raises(OpError):
        m.apply({"kind": "connect", "edgeId": "e2", "type": "child",
                 "from": {"node": "box2", "port": "children"}, "to": {"node": "box", "port": "parent"}})


def test_disconnect_unknown_rejected():
    m = _with_nodes()
    with pytest.raises(OpError) as e:
        m.apply({"kind": "disconnect", "edgeId": "nope"})
    assert e.value.code == "unknown_edge"


def test_remove_node_cascades_incident_edges():
    m = _with_nodes()
    m.apply(_child("e1", "root", "box"))
    m.apply(_data("e2", "tex", "s"))
    m.apply(_child("e3", "box", "s"))
    m.apply({"kind": "removeNode", "id": "s"})
    assert m.get_edge("e2") is None and m.get_edge("e3") is None
    assert m.get_edge("e1") is not None  # untouched (not incident to s)


def test_apply_batch_all_or_nothing():
    m = GraphModel()
    with pytest.raises(OpError):
        m.apply_batch([
            {"kind": "addNode", "id": "a", "type": "Sprite"},
            {"kind": "addNode", "id": "a", "type": "Sprite"},  # duplicate
        ])
    assert m.get_node("a") is None  # first op rolled back


def test_apply_batch_success():
    m = GraphModel()
    m.apply_batch([
        {"kind": "addNode", "id": "root", "type": "Root"},
        {"kind": "addNode", "id": "s", "type": "Sprite"},
        _child("e1", "root", "s"),
    ])
    assert m.get_node("s") is not None and m.get_edge("e1") is not None


def test_set_prop_rejects_prototype_pollution_paths():
    m = GraphModel()
    m.apply({"kind": "addNode", "id": "s", "type": "Sprite"})
    for bad in ("__proto__", "constructor", "prototype", "a.__proto__.x"):
        with pytest.raises(OpError) as e:
            m.apply({"kind": "setProp", "id": "s", "path": bad, "value": 1})
        assert e.value.code == "invalid_path"
    # a normal nested path still works
    m.apply({"kind": "setProp", "id": "s", "path": "position.x", "value": 5})
    assert m.get_node("s")["props"]["position"]["x"] == 5


def test_load_round_trips_document():
    doc = {
        "version": 1,
        "nodes": {
            "root": {"id": "root", "type": "Root", "props": {"width": 800, "height": 600}},
            "s": {"id": "s", "type": "Sprite", "props": {"alpha": 1}},
        },
        "edges": [{"id": "e1", "type": "child",
                   "from": {"node": "root", "port": "children"},
                   "to": {"node": "s", "port": "parent"}}],
    }
    m = GraphModel()
    m.load(doc)
    assert m.to_document() == doc


def _wired():
    from app.scene.graph_model import GraphModel
    m = GraphModel()
    m.apply({"kind": "addNode", "id": "root", "type": "Root"})
    m.apply({"kind": "addNode", "id": "box", "type": "Container"})
    m.apply({"kind": "addNode", "id": "s", "type": "Sprite"})
    m.apply({"kind": "addNode", "id": "tex", "type": "Texture", "props": {"src": "asset:1"}})
    return m


def test_reversed_data_edge_rejected():
    from app.scene.document import OpError
    m = _wired()
    with pytest.raises(OpError) as ei:
        m.apply({"kind": "connect", "edgeId": "bad", "type": "data",
                 "from": {"node": "s", "port": "data"}, "to": {"node": "tex", "port": "texture"}})
    assert ei.value.code == "invalid_edge"


def test_data_edge_to_non_texture_port_rejected():
    from app.scene.document import OpError
    m = _wired()
    with pytest.raises(OpError) as ei:
        m.apply({"kind": "connect", "edgeId": "bad", "type": "data",
                 "from": {"node": "tex", "port": "data"}, "to": {"node": "s", "port": "parent"}})
    assert ei.value.code == "invalid_edge"


def test_child_edge_swapped_ports_rejected():
    from app.scene.document import OpError
    m = _wired()
    with pytest.raises(OpError) as ei:
        m.apply({"kind": "connect", "edgeId": "bad", "type": "child",
                 "from": {"node": "root", "port": "parent"}, "to": {"node": "box", "port": "children"}})
    assert ei.value.code == "invalid_edge"


def test_child_edge_into_texture_rejected():
    from app.scene.document import OpError
    m = _wired()
    with pytest.raises(OpError) as ei:
        m.apply({"kind": "connect", "edgeId": "bad", "type": "child",
                 "from": {"node": "root", "port": "children"}, "to": {"node": "tex", "port": "parent"}})
    assert ei.value.code == "invalid_edge"


def test_remove_root_rejected():
    from app.scene.graph_model import GraphModel
    from app.scene.document import OpError
    m = GraphModel()
    m.apply({"kind": "addNode", "id": "root", "type": "Root"})
    with pytest.raises(OpError) as ei:
        m.apply({"kind": "removeNode", "id": "root"})
    assert ei.value.code == "cannot_remove_root"


def test_second_root_rejected():
    from app.scene.graph_model import GraphModel
    from app.scene.document import OpError
    m = GraphModel()
    m.apply({"kind": "addNode", "id": "root", "type": "Root"})
    with pytest.raises(OpError) as ei:
        m.apply({"kind": "addNode", "id": "root2", "type": "Root"})
    assert ei.value.code == "root_exists"


def test_unreachable_nodes_flags_orphan_then_clears():
    from app.scene.document import unreachable_nodes
    doc = {
        "version": 1,
        "nodes": {
            "root": {"id": "root", "type": "Root", "props": {}},
            "s": {"id": "s", "type": "Sprite", "props": {}},
            "tex": {"id": "tex", "type": "Texture", "props": {"src": "a"}},
        },
        "edges": [],
    }
    assert unreachable_nodes(doc) == ["s"]
    doc["edges"].append({"id": "e", "type": "child",
                         "from": {"node": "root", "port": "children"},
                         "to": {"node": "s", "port": "parent"}})
    assert unreachable_nodes(doc) == []

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

from app.assets.graph import build_graph, patch_graph, random_seed


def _base():
    return {
        "6": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["4", 1], "text": "OLD"}},
        "5": {"class_type": "EmptySD3LatentImage", "inputs": {"width": 1216, "height": 832, "batch_size": 1}},
        "3": {"class_type": "KSampler", "inputs": {"seed": 1, "steps": 4}},
    }


def test_patch_sets_prompt_size_seed_without_mutating_base():
    base = _base()
    out = patch_graph(base, prompt="NEW", width=512, height=768, seed=99)
    assert out["6"]["inputs"]["text"] == "NEW"
    assert out["5"]["inputs"]["width"] == 512 and out["5"]["inputs"]["height"] == 768
    assert out["3"]["inputs"]["seed"] == 99
    assert out["3"]["inputs"]["steps"] == 4  # untouched fields preserved
    # base is not mutated
    assert base["6"]["inputs"]["text"] == "OLD" and base["3"]["inputs"]["seed"] == 1


def test_build_graph_loads_each_named_workflow():
    for wf in ("schnell-opaque", "schnell-transparent", "dev-transparent"):
        g = build_graph(wf, prompt="hello", width=256, height=256, seed=5)
        assert g["6"]["inputs"]["text"] == "hello"
        assert g["5"]["inputs"]["width"] == 256
        assert g["3"]["inputs"]["seed"] == 5


def test_random_seed_in_range():
    s = random_seed()
    assert 0 <= s <= 2**32 - 1

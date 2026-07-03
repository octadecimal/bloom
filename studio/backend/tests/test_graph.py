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


def test_patch_sets_generation_params_on_their_nodes():
    base = {
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "OLD"}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": ""}},
        "5": {"class_type": "EmptySD3LatentImage", "inputs": {"width": 1216, "height": 832}},
        "3": {"class_type": "KSampler", "inputs": {"seed": 1, "steps": 4, "cfg": 1.0}},
        "11": {"class_type": "FluxGuidance", "inputs": {"guidance": 3.5}},
    }
    out = patch_graph(base, prompt="NEW", width=512, height=512, seed=7,
                      negative="blurry", steps=24, cfg=2.0, guidance=3.0)
    assert out["7"]["inputs"]["text"] == "blurry"
    assert out["3"]["inputs"]["steps"] == 24 and out["3"]["inputs"]["cfg"] == 2.0
    assert out["11"]["inputs"]["guidance"] == 3.0
    # base untouched
    assert base["3"]["inputs"]["steps"] == 4


def test_guidance_patch_is_a_noop_when_no_flux_guidance_node():
    base = {
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "x"}},
        "5": {"class_type": "EmptySD3LatentImage", "inputs": {"width": 1, "height": 1}},
        "3": {"class_type": "KSampler", "inputs": {"seed": 1, "steps": 4, "cfg": 1.0}},
    }
    out = patch_graph(base, prompt="p", width=64, height=64, seed=1, guidance=9.0)
    assert "11" not in out  # schnell has no FluxGuidance; no crash, no node added


def test_none_params_leave_baked_values_untouched():
    out = build_graph("dev-transparent", prompt="p", width=64, height=64, seed=1)
    # dev-transparent bakes steps=24, guidance=3.5
    assert out["3"]["inputs"]["steps"] == 24
    assert out["11"]["inputs"]["guidance"] == 3.5


def test_dev_opaque_workflow_loads_with_guidance_and_no_rmbg():
    g = build_graph("dev-opaque", prompt="p", width=128, height=128, seed=3)
    assert g["6"]["inputs"]["text"] == "p"
    assert "11" in g  # FluxGuidance present (dev)
    class_types = {n.get("class_type") for n in g.values()}
    assert "BiRefNetRMBG" not in class_types  # opaque: no background removal
    assert "SaveImage" in class_types

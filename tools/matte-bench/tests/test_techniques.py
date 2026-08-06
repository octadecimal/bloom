import json

from matte_bench.techniques import (
    Technique, config_hash, load_techniques, matting_graph, stage1_models,
)


def _t(**over):
    base = dict(id="birefnet-hr", cls="A", node="BiRefNetRMBG",
                model="BiRefNet-HR", params={"mask_blur": 0}, post=())
    return Technique(**{**base, **over})


def test_config_hash_is_stable_and_ignores_id():
    assert config_hash(_t()) == config_hash(_t(id="renamed"))


def test_config_hash_changes_with_params():
    assert config_hash(_t()) != config_hash(_t(params={"mask_blur": 4}))


def test_config_hash_changes_with_postops():
    assert config_hash(_t()) != config_hash(_t(post=(("despeckle", 0.001),)))


def test_stage1_builds_one_technique_per_installed_model():
    ts = stage1_models({"BiRefNetRMBG": ["BiRefNet-HR"], "RMBG": ["BEN2"]})
    assert [t.model for t in ts] == ["BiRefNet-HR", "BEN2"]
    assert {t.cls for t in ts} == {"A"}
    assert len({t.id for t in ts}) == 2  # ids unique


def test_matting_graph_loads_uploaded_image_and_saves_result():
    g = matting_graph(_t(), "plate_s1.png")
    kinds = {n["class_type"] for n in g.values()}
    assert kinds == {"LoadImage", "BiRefNetRMBG", "SaveImage"}
    load_id = next(k for k, n in g.items() if n["class_type"] == "LoadImage")
    assert g[load_id]["inputs"]["image"] == "plate_s1.png"
    matte_id = next(k for k, n in g.items() if n["class_type"] == "BiRefNetRMBG")
    assert g[matte_id]["inputs"]["image"] == [load_id, 0]
    assert g[matte_id]["inputs"]["model"] == "BiRefNet-HR"
    assert g[matte_id]["inputs"]["background"] == "Alpha"


def test_load_techniques_round_trip(tmp_path):
    path = tmp_path / "techniques.json"
    path.write_text(json.dumps([{
        "id": "x", "cls": "A", "node": "RMBG", "model": "BEN2",
        "params": {}, "post": [["despeckle", 0.0005]],
    }]), encoding="utf-8")
    ts = load_techniques(path)
    assert ts[0].post == (("despeckle", 0.0005),)


def test_stage1_ids_are_unique_across_nodes_and_separators():
    ts = stage1_models({
        "BiRefNetRMBG": ["BiRefNet-HR", "BiRefNet_HR"],
        "RMBG": ["BiRefNet-HR"],
    })
    assert len({t.id for t in ts}) == 3


def test_technique_is_hashable():
    assert len({_t(), _t(id="renamed")}) == 1
    assert len({_t(), _t(params={"mask_blur": 4})}) == 2


def test_backdrop_hashes_left_retired_identities_behind():
    """26ebdc9a25576982 / 8d9d35012cc502c2 are poisoned (both_bad verdicts
    against never-keyed renders, PR #229). 552a60c75a287bb0 /
    4bc8eba4d3cfc3d5 are keying v1 (global key: halo retention + subject
    erosion, measured live 2026-08-06). The log is append-only, so keying v2
    must carry fresh identities."""
    from matte_bench.techniques import backdrop_techniques
    retired = {"26ebdc9a25576982", "8d9d35012cc502c2",
               "552a60c75a287bb0", "4bc8eba4d3cfc3d5"}
    assert {config_hash(t) for t in backdrop_techniques()}.isdisjoint(retired)


def test_backdrop_techniques_are_class_b_with_key_params():
    from matte_bench.techniques import backdrop_techniques
    got = backdrop_techniques()
    assert len(got) == 2
    assert all(t.cls == "B" and t.node == "backdrop-key" for t in got)
    for t in got:
        assert {"clause", "key_color", "key_source", "seed_tolerance",
                "step_tolerance", "hole_tolerance", "softness",
                "despill"} <= set(t.params)
        assert t.params["key_source"] == "border-median"
    assert len({config_hash(t) for t in got}) == 2   # variants hash apart


def test_backdrop_clause_fights_the_vignette():
    """Layered halo defense: the clause asks flux for a uniform backdrop so
    the keyer has less gradient to chase."""
    from matte_bench.techniques import BACKDROP_VARIANTS
    for _, _, clause in BACKDROP_VARIANTS:
        assert "no vignetting" in clause
        assert "no gradient" in clause


def test_qwen_techniques_gated_on_weights():
    from matte_bench.techniques import qwen_techniques
    assert qwen_techniques(None) == []
    weights = {"unet": "qwen_image_fp8_e4m3fn.safetensors",
               "clip": "qwen_2.5_vl_7b_fp8_scaled.safetensors",
               "vae": "qwen_image_vae.safetensors"}
    [t] = qwen_techniques(weights)
    assert t.cls == "B" and t.node == "qwen-layered"
    assert t.model == weights["unet"]
    assert t.params == {"clip": weights["clip"], "vae": weights["vae"]}


from matte_bench.techniques import qwen_graph, qwen_techniques


def test_qwen_graph_wires_layered_latent():
    [t] = qwen_techniques({"unet": "u.safetensors", "clip": "c.safetensors",
                           "vae": "v.safetensors"})
    g = qwen_graph(t, "a glowing lantern", 768, 512, seed=7)
    classes = {n["class_type"] for n in g.values()}
    assert "EmptyQwenImageLayeredLatentImage" in classes
    assert "UNETLoader" in classes and "CLIPLoader" in classes and "VAELoader" in classes
    latent = next(n for n in g.values()
                  if n["class_type"] == "EmptyQwenImageLayeredLatentImage")
    assert latent["inputs"]["width"] == 768 and latent["inputs"]["height"] == 512
    sampler = next(n for n in g.values() if n["class_type"] == "KSampler")
    assert sampler["inputs"]["seed"] == 7
    text = next(n for n in g.values()
                if n["class_type"] == "CLIPTextEncode"
                and n["inputs"]["text"])["inputs"]["text"]
    assert text == "a glowing lantern"

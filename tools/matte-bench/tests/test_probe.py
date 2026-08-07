import httpx
import matte_bench.probe as probe_mod
from matte_bench.probe import available_models, checkpoint_installed, plate_checkpoint, qwen_weights

OBJECT_INFO = {
    "BiRefNetRMBG": {"input": {"required": {
        "image": ["IMAGE", {}],
        "model": [["BiRefNet-HR", "BiRefNet_lite"], {}],
    }}},
    "RMBG": {"input": {"required": {
        "image": ["IMAGE", {}],
        "model": [["RMBG-2.0", "BEN2"], {}],
    }}},
    "KSampler": {"input": {"required": {"seed": ["INT", {}]}}},
}


def test_available_models_lists_only_matting_nodes():
    assert available_models(OBJECT_INFO) == {
        "BiRefNetRMBG": ["BiRefNet-HR", "BiRefNet_lite"],
        "RMBG": ["RMBG-2.0", "BEN2"],
    }


def test_available_models_omits_absent_nodes():
    assert available_models({"KSampler": {"input": {"required": {}}}}) == {}


def _info(**nodes):
    return dict(nodes)


def _loader(key, choices):
    return {"input": {"required": {key: [choices]}}}


def test_checkpoint_installed_checks_both_loaders():
    info = _info(CheckpointLoaderSimple=_loader("ckpt_name", ["flux1-dev-fp8.safetensors"]))
    assert checkpoint_installed(info, "flux1-dev-fp8.safetensors")
    assert not checkpoint_installed(info, "missing.safetensors")
    info2 = _info(UNETLoader=_loader("unet_name", ["qwen_image_fp8_e4m3fn.safetensors"]))
    assert checkpoint_installed(info2, "qwen_image_fp8_e4m3fn.safetensors")


def test_plate_checkpoint_reads_built_graph():
    graph = {"1": {"class_type": "CheckpointLoaderSimple",
                   "inputs": {"ckpt_name": "flux1-dev-fp8.safetensors"}},
             "2": {"class_type": "KSampler", "inputs": {}}}
    assert plate_checkpoint(graph) == "flux1-dev-fp8.safetensors"
    assert plate_checkpoint({"2": {"class_type": "KSampler", "inputs": {}}}) is None


def test_qwen_weights_requires_full_trio_and_node():
    full = _info(
        UNETLoader=_loader("unet_name", ["qwen_image_fp8_e4m3fn.safetensors"]),
        CLIPLoader=_loader("clip_name", ["qwen_2.5_vl_7b_fp8_scaled.safetensors"]),
        VAELoader=_loader("vae_name", ["qwen_image_vae.safetensors"]),
        EmptyQwenImageLayeredLatentImage={"input": {"required": {}}},
    )
    got = qwen_weights(full)
    assert got == {"unet": "qwen_image_fp8_e4m3fn.safetensors",
                   "clip": "qwen_2.5_vl_7b_fp8_scaled.safetensors",
                   "vae": "qwen_image_vae.safetensors"}
    no_vae = dict(full)
    no_vae["VAELoader"] = _loader("vae_name", ["taesd"])
    assert qwen_weights(no_vae) is None
    no_node = {k: v for k, v in full.items()
               if k != "EmptyQwenImageLayeredLatentImage"}
    assert qwen_weights(no_node) is None


def test_comfy_unreachable_is_none_when_box_answers(monkeypatch):
    class Resp:
        def raise_for_status(self):
            pass

    monkeypatch.setattr(probe_mod.httpx, "get", lambda url, timeout: Resp())
    assert probe_mod.comfy_unreachable("http://gpu:8188") is None


def test_comfy_unreachable_reports_the_reason(monkeypatch):
    def boom(url, timeout):
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(probe_mod.httpx, "get", boom)
    assert "refused" in probe_mod.comfy_unreachable("http://gpu:8188")


def test_comfy_unreachable_never_returns_an_empty_reason(monkeypatch):
    """str(exc) can be empty (e.g. bare timeout classes); the operator-facing
    message must still name the failure."""
    def boom(url, timeout):
        raise httpx.ConnectTimeout("")

    monkeypatch.setattr(probe_mod.httpx, "get", boom)
    assert probe_mod.comfy_unreachable("http://gpu:8188") == "ConnectTimeout"

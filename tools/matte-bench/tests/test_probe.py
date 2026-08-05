from matte_bench.probe import available_models

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

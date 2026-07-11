import pytest
from app.math.targets import TargetGap, derive_num_bonuses


def test_num_bonuses_prefers_gdd_when_consistent():
    assert derive_num_bonuses({"features": [{"name": "FS"}]},
                              {"bonuses": [{"FreeSpins": {}}]}) == 1


def test_num_bonuses_falls_back_to_model_when_gdd_empty():
    assert derive_num_bonuses({}, {"bonuses": [{"FreeSpins": {}}]}) == 1
    assert derive_num_bonuses({"features": []}, {"bonuses": []}) == 0


def test_num_bonuses_raises_on_drift():
    with pytest.raises(TargetGap):
        derive_num_bonuses({"features": [{"name": "a"}, {"name": "b"}]},
                           {"bonuses": [{"FreeSpins": {}}]})

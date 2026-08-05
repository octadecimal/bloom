from pathlib import Path

from matte_bench.corpus import Subject
from matte_bench.session import install_state
from matte_bench.techniques import Technique, config_hash
from matte_bench.web import State


def _t(tid="birefnet-hr", model="BiRefNet-HR"):
    return Technique(id=tid, cls="A", node="BiRefNetRMBG", model=model,
                     params={}, post=())


def test_install_state_exposes_config_hashes_not_ids(tmp_path: Path):
    """The UI fetches /render/<subject>/<hash>.png, so state carries hashes."""
    st = State()
    subjects = [Subject(id="s1", bucket="wispy", prompt="p", seed=1,
                        width=8, height=8)]
    install_state(st, subjects, [_t()], tmp_path)
    assert st.techniques == [config_hash(_t())]


def test_install_state_records_plate_hashes(tmp_path: Path):
    st = State()
    s = Subject(id="s1", bucket="wispy", prompt="p", seed=1, width=8, height=8)
    plate = tmp_path / "plates" / "s1.png"
    plate.parent.mkdir(parents=True)
    plate.write_bytes(b"pixels")
    install_state(st, [s], [_t()], tmp_path)
    assert set(st.plate_hashes) == {"s1"}

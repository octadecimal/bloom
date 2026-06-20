from pathlib import Path

from app.assets.media import MediaStore


def test_save_writes_file_and_returns_url(tmp_path):
    store = MediaStore(tmp_path)
    ref = store.save("g1", "a1", "gen1", b"\x89PNGdata")
    assert ref == "/media/g1/a1/gen1.png"
    written = tmp_path / "g1" / "a1" / "gen1.png"
    assert written.read_bytes() == b"\x89PNGdata"

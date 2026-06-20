from pathlib import Path


class MediaStore:
    def __init__(self, root):
        self.root = Path(root)

    def save(self, game_id: str, asset_id: str, gen_id: str, data: bytes) -> str:
        directory = self.root / game_id / asset_id
        directory.mkdir(parents=True, exist_ok=True)
        (directory / f"{gen_id}.png").write_bytes(data)
        return f"/media/{game_id}/{asset_id}/{gen_id}.png"

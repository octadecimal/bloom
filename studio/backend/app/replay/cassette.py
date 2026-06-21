import json
import re
from pathlib import Path

DEFAULT_FIXTURES_DIR = Path(__file__).resolve().parent.parent.parent / "tests" / "fixtures" / "replay"


def normalize_prompt(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def load_llm_cassettes(fixtures_dir: Path) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    llm_dir = fixtures_dir / "llm"
    for path in sorted(llm_dir.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        out[normalize_prompt(data["prompt"])] = list(data["chunks"])
        if path.name == "default.json":
            out["__default__"] = list(data["chunks"])
    return out


def load_comfy_cassette(fixtures_dir: Path) -> tuple[list[tuple[int, int]], bytes]:
    comfy_dir = fixtures_dir / "comfy"
    meta = json.loads((comfy_dir / "default.json").read_text(encoding="utf-8"))
    progress = [(int(v), int(m)) for v, m in meta["progress"]]
    image = (comfy_dir / meta["image"]).read_bytes()
    return progress, image

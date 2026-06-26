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


def load_run_cassette(fixtures_dir: Path) -> dict:
    path = Path(fixtures_dir) / "run" / "default.json"
    if not path.exists():
        return {"tool_calls": [], "final": ["ok"]}
    return json.loads(path.read_text(encoding="utf-8"))


def load_run_cassettes(fixtures_dir: Path) -> dict[str, dict]:
    """Load run cassettes keyed by normalized prompt.

    Each ``run/*.json`` is ``{tool_calls, final}`` with an optional ``prompt``.
    ``default.json`` becomes ``"__default__"`` (the fallback). Files with a
    ``prompt`` are also keyed by ``normalize_prompt(prompt)``.
    """
    out: dict[str, dict] = {}
    run_dir = Path(fixtures_dir) / "run"
    if not run_dir.is_dir():
        return out
    for path in sorted(run_dir.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        cassette: dict = {
            "tool_calls": data.get("tool_calls", []),
            "final": data.get("final", ["ok"]),
        }
        if "tool_call_rounds" in data:
            cassette["tool_call_rounds"] = data["tool_call_rounds"]
        if path.name == "default.json":
            out["__default__"] = cassette
        if "prompt" in data:
            out[normalize_prompt(data["prompt"])] = cassette
    return out

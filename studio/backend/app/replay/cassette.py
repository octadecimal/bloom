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


def load_critic_cassettes(fixtures_dir: Path) -> dict[str, list[dict]]:
    """Load vision-critic cassettes keyed by normalized target handle.

    Each ``critic/*.json`` is ``{passes: [<Critique-shaped dict>, ...]}`` with an
    optional ``target``. ``default.json`` becomes ``"__default__"`` (the
    fallback). Files with a ``target`` are also keyed by
    ``normalize_prompt(target)``. Mirrors ``load_run_cassettes`` — the critic is
    a direct structured+image call with its OWN cassette format (per-pass
    critiques), distinct from the tool-call run cassettes.
    """
    out: dict[str, list[dict]] = {}
    critic_dir = Path(fixtures_dir) / "critic"
    if not critic_dir.is_dir():
        return out
    for path in sorted(critic_dir.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        passes = list(data.get("passes", []))
        if path.name == "default.json":
            out["__default__"] = passes
        if "target" in data:
            out[normalize_prompt(data["target"])] = passes
    return out


def load_scene_art_cassettes(fixtures_dir: Path) -> dict[str, list[dict]]:
    """Load scene art/effects-critic cassettes keyed by normalized theme.

    Each ``scene_art/*.json`` is ``{passes: [<SceneArtVerdict-shaped dict>, ...]}``
    with an optional ``theme``. ``default.json`` becomes ``"__default__"`` (the
    fallback). Files with a ``theme`` are also keyed by ``normalize_prompt(theme)``.
    Mirrors ``load_critic_cassettes`` — the art critic is a direct structured+image
    call with its OWN per-pass cassette format, keyed by build theme.
    """
    out: dict[str, list[dict]] = {}
    base = Path(fixtures_dir) / "scene_art"
    if not base.is_dir():
        return out
    for path in sorted(base.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        passes = list(data.get("passes", []))
        if path.name == "default.json":
            out["__default__"] = passes
        if "theme" in data:
            out[normalize_prompt(data["theme"])] = passes
    return out


def load_asset_cassettes(fixtures_dir: Path) -> dict[str, list[dict]]:
    """Recorded per-role asset verdicts from ``tests/fixtures/replay/asset/``.

    Each file is EITHER a single verdict dict (returned for every attempt) OR a
    JSON list of verdict dicts (one per regenerate->re-judge attempt; the asset
    critic clamps the attempt index to the last entry). ``default.json`` becomes
    ``"__default__"``. Files with a ``role``/``target`` key are also keyed by
    ``normalize_prompt(role)``.
    """
    out: dict[str, list[dict]] = {}
    base = fixtures_dir / "asset"
    if not base.is_dir():
        return out
    for path in sorted(base.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, list):
            verdicts = [{k: v for k, v in d.items() if k not in ("role", "target")} for d in data]
            key = None
            for d in data:
                key = d.get("role") or d.get("target") or key
        else:
            verdicts = [{k: v for k, v in data.items() if k not in ("role", "target")}]
            key = data.get("role") or data.get("target")
        if path.name == "default.json":
            out["__default__"] = verdicts
        if key:
            out[normalize_prompt(key)] = verdicts
    return out

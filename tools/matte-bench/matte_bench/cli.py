def main(argv: list[str]) -> int:
    import asyncio
    import os
    from pathlib import Path

    from app.config import get_settings

    from matte_bench.probe import available_models, fetch_object_info

    settings = get_settings()
    repo = Path(__file__).resolve().parents[3]
    root = repo / "var" / "matte-bench"
    templates_path = repo / "tools" / "matte-bench" / "templates.json"
    subject_log = repo / "tools" / "matte-bench" / "subjects-sampled.jsonl"

    if argv and argv[0] == "probe":
        found = available_models(fetch_object_info(settings.comfyui_url))
        if not found:
            print(f"No matting nodes on {settings.comfyui_url}")
            return 1
        for node, models in found.items():
            print(f"{node}: {len(models)} models")
            for m in models:
                print(f"  {m}")
        return 0

    import uvicorn

    from matte_bench.session import bootstrap, install_state
    from matte_bench.web import app, state

    subjects, templates, techniques, warnings = asyncio.run(
        bootstrap(root, templates_path, subject_log, settings.comfyui_url))
    install_state(state, subjects, techniques, root, settings.comfyui_url,
                  templates=templates, subject_log=subject_log)
    print(f"{len(subjects)} known subjects, {len(techniques)} techniques; "
          "sampling fresh subjects on demand")
    for w in warnings:
        print(f"  WARNING {w}")
    port = 8400 + int(os.environ.get("BLOOM_PORT_OFFSET") or 0)
    uvicorn.run(app, host="0.0.0.0", port=port)
    return 0

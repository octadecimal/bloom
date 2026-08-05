import os

from app.config import get_settings

from matte_bench.probe import available_models, fetch_object_info


def main(argv: list[str]) -> int:
    settings = get_settings()
    if argv and argv[0] == "probe":
        info = fetch_object_info(settings.comfyui_url)
        found = available_models(info)
        if not found:
            print(f"No matting nodes on {settings.comfyui_url}")
            return 1
        for node, models in found.items():
            print(f"{node}: {len(models)} models")
            for m in models:
                print(f"  {m}")
        return 0
    import uvicorn
    from matte_bench.web import app
    port = 8400 + int(os.environ.get("BLOOM_PORT_OFFSET") or 0)
    uvicorn.run(app, host="0.0.0.0", port=port)
    return 0

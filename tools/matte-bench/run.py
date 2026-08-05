"""Launcher: puts studio/backend and the bench on sys.path, then runs the app."""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "studio" / "backend"))
sys.path.insert(0, str(pathlib.Path(__file__).parent))

if __name__ == "__main__":
    from matte_bench.cli import main
    raise SystemExit(main(sys.argv[1:]))

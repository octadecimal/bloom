import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "studio" / "backend"))
sys.path.insert(0, str(ROOT / "tools" / "matte-bench"))

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2]


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture
def live_server():
    port = _free_port()
    env = {
        **os.environ,
        "LLM_BACKEND": "fake",
        "FAKE_TOKEN_DELAY": "0.15",
        "MONGO_DB": "bloom_studio_e2e",
    }
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(port)],
        cwd=str(BACKEND_DIR),
        env=env,
    )
    base_url = f"http://127.0.0.1:{port}"
    deadline = time.time() + 20
    while time.time() < deadline:
        try:
            if httpx.get(f"{base_url}/health", timeout=1).status_code == 200:
                break
        except Exception:
            time.sleep(0.2)
    else:
        proc.terminate()
        raise RuntimeError("live server did not start")

    yield base_url

    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()

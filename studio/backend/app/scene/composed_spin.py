"""HTTP seam to the authoritative Rust runtime server for composed@1 scene
spins. No subprocess anywhere on this path, so it cannot hit the Windows
--reload SelectorEventLoop gap the SlotModel spin runner needs wrapping for."""
import os

import httpx


class ComposedSpinError(Exception):
    """User-facing spin failure (message is rendered in the Game Scene pane)."""


class ComposedSpinClient:
    def __init__(self, base_url: str, *, timeout_s: float = 10.0,
                 transport: httpx.AsyncBaseTransport | None = None):
        self.base_url = base_url.rstrip("/")
        self._timeout_s = timeout_s
        self._transport = transport

    async def spin(self, package_id: str) -> dict:
        try:
            async with httpx.AsyncClient(timeout=self._timeout_s, transport=self._transport) as client:
                r = await client.post(f"{self.base_url}/spin", json={"bet": 1, "package": package_id})
        except httpx.HTTPError as exc:
            raise ComposedSpinError(
                f"runtime server unreachable at {self.base_url} — start it with: just runtime-serve-packages"
            ) from exc
        if r.status_code == 404:
            raise ComposedSpinError(
                "package not built yet — it builds automatically after a Game Structure save; try again shortly"
            )
        if r.status_code != 200:
            raise ComposedSpinError(f"runtime server error {r.status_code}: {r.text[:200]}")
        try:
            return r.json()
        except ValueError as exc:  # JSONDecodeError subclasses ValueError; httpx may raise either
            raise ComposedSpinError(f"runtime server returned invalid JSON: {exc}") from exc


def build_composed_spin_client(settings) -> ComposedSpinClient:
    url = settings.runtime_server_url
    if not url:
        offset = int(os.environ.get("BLOOM_PORT_OFFSET", "0") or 0)
        url = f"http://localhost:{9000 + offset}"
    return ComposedSpinClient(url)

# Matte-bench ComfyUI Outage Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the remote ComfyUI box is unreachable, the judging bench must say so in the status bar instead of reporting "No comparisons left." — and must stop retiring techniques over transient outages.

**Architecture:** A cheap reachability probe (`GET /system_stats`, 3s timeout) is consulted whenever `_compute_next` is about to blame a technique or report the session done. Unreachable → the `/api/next` job errors with `ComfyUI unreachable at <url>: <reason>` (existing `_NextJob.error` → HTTP 500 `detail` path; no API shape change) and no technique is dropped. The client's `load()` error path learns to render the JSON `detail`. The probe is injected via `state.comfy_probe` so the web tests control it deterministically.

**Tech Stack:** Python (FastAPI, httpx, pytest via `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -q`), TypeScript (vitest + jsdom harness in `tools/matte-bench/ui-tests`, run via `cd tools/matte-bench && npx vitest run`).

**Spec:** `docs/superpowers/specs/2026-08-07-matte-bench-comfy-visibility-design.md`

## Global Constraints

- Working directory is the worktree `C:\code\bloom.wt\matte-bench-followups`, branch `test/matte-bench-followups` (PR #232 is open on it).
- Semantic commit format (Conventional Commits), imperative mood.
- TDD: every step's test must be watched failing before the implementation lands.
- The error message format is exactly: `ComfyUI unreachable at {url}: {reason}` (url first, reason after a colon).
- No changes to keying params, technique configs, or anything that feeds `config_hash` — no hash retirement.

---

### Task 1: `comfy_unreachable` probe helper

**Files:**
- Modify: `tools/matte-bench/matte_bench/probe.py`
- Test: `tools/matte-bench/tests/test_probe.py`

**Interfaces:**
- Produces: `comfy_unreachable(base_url: str, timeout: float = 3.0) -> str | None` — returns the failure-reason string when the ComfyUI box does not answer `GET {base_url}/system_stats`, or `None` when it does. Task 2 imports it into `web.py`.

- [ ] **Step 1: Write the failing tests**

Append to `tools/matte-bench/tests/test_probe.py` (it already imports the probe module — match its existing import style; if it uses `from matte_bench.probe import ...`, add `comfy_unreachable` there and import `httpx` and `matte_bench.probe as probe_mod` as needed):

```python
def test_comfy_unreachable_is_none_when_box_answers(monkeypatch):
    class Resp:
        def raise_for_status(self):
            pass

    monkeypatch.setattr(probe_mod.httpx, "get", lambda url, timeout: Resp())
    assert probe_mod.comfy_unreachable("http://gpu:8188") is None


def test_comfy_unreachable_reports_the_reason(monkeypatch):
    def boom(url, timeout):
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(probe_mod.httpx, "get", boom)
    assert "refused" in probe_mod.comfy_unreachable("http://gpu:8188")


def test_comfy_unreachable_never_returns_an_empty_reason(monkeypatch):
    """str(exc) can be empty (e.g. bare timeout classes); the operator-facing
    message must still name the failure."""
    def boom(url, timeout):
        raise httpx.ConnectTimeout("")

    monkeypatch.setattr(probe_mod.httpx, "get", boom)
    assert probe_mod.comfy_unreachable("http://gpu:8188") == "ConnectTimeout"
```

(`import httpx` and `import matte_bench.probe as probe_mod` at the top if not already present under those names.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_probe.py -q`
Expected: 3 FAIL with `AttributeError: ... has no attribute 'comfy_unreachable'`

- [ ] **Step 3: Implement**

Append to `tools/matte-bench/matte_bench/probe.py`:

```python
def comfy_unreachable(base_url: str, timeout: float = 3.0) -> str | None:
    """Reason the ComfyUI box did not answer, or None when it did.

    Cheap (GET /system_stats, short timeout) — used to tell an infra outage
    apart from a genuinely broken technique before blaming the technique."""
    try:
        httpx.get(f"{base_url.rstrip('/')}/system_stats",
                  timeout=timeout).raise_for_status()
    except Exception as exc:                          # noqa: BLE001 - the reason IS the payload
        return str(exc) or type(exc).__name__
    return None
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_probe.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/probe.py tools/matte-bench/tests/test_probe.py
git commit -m "feat(matte-bench): add comfy_unreachable probe helper"
```

---

### Task 2: outage classification in `_compute_next`

**Files:**
- Modify: `tools/matte-bench/matte_bench/web.py` (State dataclass ~line 40-65, `_compute_next` ~line 295-330, imports ~line 15-31)
- Test: `tools/matte-bench/tests/test_web.py` (`_client` helper ~line 17-58)

**Interfaces:**
- Consumes: `comfy_unreachable(base_url, timeout=3.0) -> str | None` from Task 1.
- Produces: `state.comfy_probe` (callable `str -> str | None`, defaults to `comfy_unreachable`); `_raise_if_comfy_down()` raising `RuntimeError(f"ComfyUI unreachable at {state.comfy_url}: {reason}")`. The error string reaches clients as `/api/next` HTTP 500 `{"detail": ...}` via the existing `_NextJob.error` path — Task 3's client change relies on that `detail` wording.

- [ ] **Step 1: Make the web tests deterministic about reachability**

In `tools/matte-bench/tests/test_web.py`, inside `_client(...)` next to the other `state.` resets (e.g. right after `state.comfy_url = "http://unused"`), add:

```python
    # Reachable by default: outage classification is opt-in per test, and the
    # probe must never hit the network from the suite.
    state.comfy_probe = lambda url: None
```

- [ ] **Step 2: Write the failing tests**

Append to `tools/matte-bench/tests/test_web.py`:

```python
def test_outage_reads_as_error_and_drops_nothing(tmp_path, monkeypatch):
    """A ComfyUI outage must NOT read as 'session done', and must not retire
    the technique that happened to be rendering (observed live 2026-08-07:
    chroma-magenta was dropped by a websocket handshake timeout)."""
    client = _client(tmp_path)

    async def down_prepare(c, progress):
        raise RuntimeError("timed out during opening handshake")

    monkeypatch.setattr(web, "_prepare", down_prepare)
    state.comfy_probe = lambda url: "timed out during opening handshake"
    deadline = time.time() + 5.0
    while time.time() < deadline:
        resp = client.get("/api/next")
        if resp.status_code == 500:
            break
        assert resp.json()["status"] == "pending", resp.json()
        time.sleep(0.01)
    assert resp.status_code == 500
    detail = resp.json()["detail"]
    assert detail == ("ComfyUI unreachable at http://unused: "
                      "timed out during opening handshake")
    assert state.techniques == ["a", "b"]
    assert state.unavailable == {}


def test_done_while_comfy_down_reads_as_error(tmp_path, monkeypatch):
    """With no comparison choosable (pool of one) the session would report
    done; when the box is ALSO unreachable, the outage is the truer story —
    this is what an operator sees when the bench booted while the box was
    off."""
    client = _client(tmp_path, monkeypatch)
    state.techniques = ["a"]
    state.technique_cls = {"a": "A"}
    state.comfy_probe = lambda url: "connect timeout"
    deadline = time.time() + 5.0
    while time.time() < deadline:
        resp = client.get("/api/next")
        if resp.status_code == 500:
            break
        assert resp.json()["status"] in ("pending", "done"), resp.json()
        time.sleep(0.01)
    assert resp.status_code == 500
    assert resp.json()["detail"] == "ComfyUI unreachable at http://unused: connect timeout"
```

Note: `_client(tmp_path, monkeypatch)` in the second test installs the no-op `_prepare`; the first test installs its own raising `_prepare` and therefore passes no monkeypatch to `_client`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_web.py -q`
Expected: the two new tests FAIL (first: `state.comfy_probe` unknown attribute on State, or 200 "done" instead of 500; second: "done" instead of 500). All pre-existing tests still pass.

- [ ] **Step 4: Implement**

In `tools/matte-bench/matte_bench/web.py`:

1. Import the probe (with the other `matte_bench.probe` imports if any exist in web.py, otherwise a new line near the other `matte_bench.` imports):

```python
from matte_bench.probe import comfy_unreachable
```

2. Add a field to the `State` dataclass (near `comfy_url`):

```python
    # Injected so tests control reachability; production uses the real probe.
    comfy_probe: object = comfy_unreachable
```

(If the dataclass rejects the bare callable default in this Python version, use `field(default=comfy_unreachable)`.)

3. Add the helper above `_compute_next`:

```python
def _raise_if_comfy_down() -> None:
    """An infra outage must read as an outage — not as 'session done' and not
    as a broken technique. Probe before blaming either."""
    reason = state.comfy_probe(state.comfy_url)
    if reason is not None:
        raise RuntimeError(f"ComfyUI unreachable at {state.comfy_url}: {reason}")
```

4. In `_compute_next`, add probe checks at all three exits that currently blame a technique or report done:

```python
        c, cls = _choose_comparison(subject, verdicts, state.rng)
        if c is None:
            _raise_if_comfy_down()
            return None
        ...
        try:
            await _prepare(c, progress)
        except RenderError as exc:
            _raise_if_comfy_down()
            # (existing drop + continue body unchanged below)
            ...
        except Exception as exc:                  # noqa: BLE001 - reported, not swallowed
            _raise_if_comfy_down()
            state.unavailable[c.left] = str(exc)
            return None
        ...
    _raise_if_comfy_down()
    return None
```

The `RuntimeError` propagates out of `_compute_next`; `_NextJob._run` already catches it into `job.error`, and `api_next` already converts `job.error` into `HTTPException(500, detail=...)` — do not change those.

- [ ] **Step 5: Run the full Python suite**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -q`
Expected: all pass (188 = 185 + 3 from Task 1 + 2 new here — verify count).

- [ ] **Step 6: Commit**

```bash
git add tools/matte-bench/matte_bench/web.py tools/matte-bench/tests/test_web.py
git commit -m "feat(matte-bench): surface ComfyUI outages instead of done/drops"
```

---

### Task 3: client renders the server's error detail

**Files:**
- Modify: `tools/matte-bench/matte_bench/static/index.html` (`load()` error path, ~line 450-455)
- Test: `tools/matte-bench/ui-tests/judge-ui.spec.ts`

**Interfaces:**
- Consumes: `/api/next` 500 responses whose JSON body is `{"detail": "ComfyUI unreachable at <url>: <reason>"}` (Task 2).

- [ ] **Step 1: Parameterize the harness's /api/next stub**

In `tools/matte-bench/ui-tests/judge-ui.spec.ts`, change `boot()` to accept an optional override for the `/api/next` response (keep the default exactly as today so the three existing tests stay untouched):

```ts
function boot(overrides: { next?: () => unknown } = {}) {
  ...
  const fetch = vi.fn((url: string) => {
    if (url === '/api/techniques') return techniques;
    if (url === '/api/next')
      return Promise.resolve(overrides.next ? overrides.next() : json({ status: 'ready', comparison: COMPARISON }));
    ...
```

- [ ] **Step 2: Write the failing test**

```ts
it('a server error surfaces its detail in the status bar', async () => {
  // The live failure this pins: ComfyUI outages used to render as a bare
  // "Error: 500 Internal Server Error" (or worse, "No comparisons left").
  const p = boot({
    next: () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ detail: 'ComfyUI unreachable at http://gpu:8188: timed out' }),
    }),
  });
  await vi.waitFor(() => {
    expect(p.status()).toContain('ComfyUI unreachable at http://gpu:8188: timed out');
    expect(p.status()).toContain('reload to retry');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd tools/matte-bench && npx vitest run`
Expected: the new test FAILS (status shows `Error: 500 Internal Server Error`); the three existing tests pass.

- [ ] **Step 4: Implement**

In `load()` in `tools/matte-bench/matte_bench/static/index.html`, replace the `!resp.ok` branch:

```js
      if (!resp.ok) {
        hideLoading();
        // The server puts the human-readable story in the JSON detail
        // (e.g. "ComfyUI unreachable at ..."); the bare status line is the
        // fallback for non-JSON errors.
        let detail = '';
        try {
          detail = (await resp.json()).detail || '';
        } catch (err) {
          /* non-JSON body */
        }
        setStatus(detail ? `Error: ${detail} — reload to retry` : `Error: ${resp.status} ${resp.statusText}`, true);
        return;
      }
```

- [ ] **Step 5: Run both suites to verify green**

Run: `cd tools/matte-bench && npx vitest run` — expected: 4 pass.
Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -q` — expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add tools/matte-bench/matte_bench/static/index.html tools/matte-bench/ui-tests/judge-ui.spec.ts
git commit -m "feat(matte-bench): show server error detail in the status bar"
```

---

### Task 4: push and refresh PR #232

- [ ] **Step 1: Push**

```bash
git push
```

- [ ] **Step 2: Update the PR title/body**

```bash
gh pr edit 232 --title "fix(matte-bench): follow-ups — render pins, judging-UI fixes, ComfyUI outage visibility"
```

and append to the body (via `gh pr edit 232 --body-file` with the old body plus):

```
## ComfyUI outage visibility (added after live outage 2026-08-07)

When the GPU box is unreachable, /api/next now errors with
"ComfyUI unreachable at <url>: <reason>" instead of reporting the session
done, techniques are no longer retired over transient outages (probe-gated:
a render failure only drops a technique when the box is answering), and the
client status bar renders the server's error detail with a reload hint.
Spec: docs/superpowers/specs/2026-08-07-matte-bench-comfy-visibility-design.md
```

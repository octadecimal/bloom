# Math Generate Cancel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Math pane's Generate button toggles into a Cancel button that hard-kills an in-flight tune/verify pipeline, discarding all work.

**Architecture:** Cancel is an on-demand version of the existing watchdog kill. Subprocess runners gain an `on_spawn` hook that hands the hub a kill callable (`kill_proc_tree(proc.pid)`); `MathHub` stores it per game next to the existing `_active` set, a new REST route trips it, and the pipeline emits a new terminal `generate_status: cancelled`. Frontend swaps the Generate button for Cancel while the pipeline runs.

**Tech Stack:** FastAPI + python-socketio backend, psutil kill primitive, React + hookstate frontend, vitest + pytest + Playwright.

**Spec:** `docs/superpowers/specs/2026-07-04-math-generate-cancel-design.md` — read it first.

## Global Constraints

- Worktree `C:\code\bloom.wt\math-generate-cancel`, branch `feat/math-generate-cancel`, `BLOOM_PORT_OFFSET=1` (backend :8001, frontend :4201) — NEVER use default ports for e2e (another session may hold them).
- Semantic commits (`feat(math): …`, `test(math): …`).
- TDD: write the failing test, watch it fail, implement, watch it pass, commit.
- TypeScript interfaces use the `I` prefix. No raw colors outside `styles.css` (reuse existing button classes).
- Backend tests: `uv run --directory studio/backend pytest tests/<file> -v` (needs local mongod on :27017).
- Frontend gates (all four before PR): `node_modules/.bin/prettier --check .`, `npx nx typecheck studio-frontend`, `npx nx test studio-frontend`, `npx nx build studio-frontend` (run from repo root; use the pinned prettier, never npx prettier).
- Discard semantics: nothing persisted on cancel — no `math_runs` doc, no `tune_result` write after the cancel flag is set.

---

### Task 1: Runner `on_spawn` hook

Give both subprocess runners an optional `on_spawn` callback that delivers a kill callable the moment the subprocess exists, and make `LoopSafeRunner` forward it (it must work on the Windows `--reload` daemon-thread path, which it does because the callable is pid-based, not loop-bound).

**Files:**

- Modify: `studio/backend/app/math/runners/tune.py` (SubprocessTunerRunner.run:139, FakeTunerRunner.run:223)
- Modify: `studio/backend/app/math/runners/curate.py` (SubprocessCurationRunner.run:68, FakeCurationRunner.run:145)
- Modify: `studio/backend/app/subprocess_guard.py` (LoopSafeRunner.run:32)
- Test: `studio/backend/tests/test_tuner_runner.py`

**Interfaces:**

- Produces: `run(..., on_progress, on_spawn=None)` on all four runners; `on_spawn: Callable[[Callable[[], None]], None]` is called exactly once per spawn with a zero-arg kill callable. `LoopSafeRunner.run(*args, on_progress=None, on_spawn=None)` forwards both keywords.

- [ ] **Step 1: Write the failing test**

Add to `studio/backend/tests/test_tuner_runner.py` (add `import asyncio` at the top):

```python
@pytest.mark.asyncio
async def test_on_spawn_delivers_a_kill_that_aborts_the_run():
    runner = _runner(timeout_s=30.0)
    runner._command = _cmd_for(_SLEEPER)
    kills = []
    task = asyncio.create_task(
        runner.run({"m": 1}, {"t": 1}, {"c": 1},
                   on_progress=lambda _p: None, on_spawn=kills.append))
    while not kills:
        await asyncio.sleep(0.01)
    kills[0]()
    res = await task
    assert res.status == "error"
    assert "no result" in res.failure.lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run --directory studio/backend pytest tests/test_tuner_runner.py::test_on_spawn_delivers_a_kill_that_aborts_the_run -v`
Expected: FAIL — `TypeError: ... unexpected keyword argument 'on_spawn'`

- [ ] **Step 3: Implement**

`tune.py`: import `kill_proc_tree` (extend the existing `from app.subprocess_guard import ...` line), change the signature and register the kill right after spawn:

```python
    async def run(self, seed_model, target, config, on_progress,
                  on_spawn=None) -> TuneResult:
```

and immediately after the `proc = await asyncio.create_subprocess_exec(...)` call:

```python
            if on_spawn is not None:
                on_spawn(lambda: kill_proc_tree(proc.pid))
```

`FakeTunerRunner.run` gains the same keyword (ignored):

```python
    async def run(self, seed_model, target, config, on_progress,
                  on_spawn=None) -> TuneResult:
```

`curate.py`: identical treatment — `SubprocessCurationRunner.run(self, model, target, on_progress, on_spawn=None)`, same `if on_spawn is not None:` block after its `create_subprocess_exec`, same import extension, and `FakeCurationRunner.run(self, model, target, on_progress, on_spawn=None)`.

`subprocess_guard.py` `LoopSafeRunner.run` — forward the new keyword on both paths:

```python
    async def run(self, *args, on_progress=None, on_spawn=None):
        if on_progress is None:
            *args, on_progress = args
        loop = asyncio.get_running_loop()
        if not (sys.platform == "win32"
                and isinstance(loop, asyncio.SelectorEventLoop)):
            return await self._inner.run(*args, on_progress=on_progress,
                                         on_spawn=on_spawn)
```

and in `worker()`:

```python
                    inner_loop.run_until_complete(
                        self._inner.run(*args, on_progress=relay,
                                        on_spawn=on_spawn)))
```

(`on_spawn` fires on the worker thread there; the hub's registration is a plain dict write, which is thread-safe under the GIL.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run --directory studio/backend pytest tests/test_tuner_runner.py tests/test_math_generate.py tests/test_math_hub.py -v`
Expected: all PASS (existing suites prove the added keyword broke nothing).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/math/runners/tune.py studio/backend/app/math/runners/curate.py studio/backend/app/subprocess_guard.py studio/backend/tests/test_tuner_runner.py
git commit -m "feat(math): runners expose on_spawn kill hook for cancellation"
```

---

### Task 2: MathHub cancel machinery

**Files:**

- Modify: `studio/backend/app/math/hub.py`
- Test: `studio/backend/tests/test_math_generate.py`

**Interfaces:**

- Consumes: Task 1's `on_spawn` keyword on runner `.run()`.
- Produces: `MathHub.cancel_generate(game_id: str) -> bool` (False when no active pipeline); `generate_status` phase `"cancelled"`; `request_tune` skips `save_tune_result` + `tuning_failed` when cancelled.

- [ ] **Step 1: Write the failing tests**

Add to `studio/backend/tests/test_math_generate.py`:

```python
class HangingTunerRunner:
    """Runs until its kill callable fires (mirrors a subprocess that only ends
    when killed); returns the error-shaped result a killed tune produces."""
    def __init__(self):
        self.spawned = asyncio.Event()
        self._killed = asyncio.Event()

    async def run(self, seed_model, target, config, on_progress, on_spawn=None):
        if on_spawn is not None:
            on_spawn(self._killed.set)
        self.spawned.set()
        await self._killed.wait()
        return TuneResult(status="error", verdict=None, tuned_model=None,
                          metrics=None, missed=[], trace=[],
                          failure="tuner produced no result (exit -9)", ran_at="t1")


class SlowSpawnTunerRunner(HangingTunerRunner):
    """Holds the 'subprocess' back until released — models cancel arriving
    before the spawn registers its kill callable."""
    def __init__(self):
        super().__init__()
        self.release_spawn = asyncio.Event()

    async def run(self, seed_model, target, config, on_progress, on_spawn=None):
        await self.release_spawn.wait()
        return await super().run(seed_model, target, config, on_progress,
                                 on_spawn=on_spawn)


class HangingCurationRunner:
    def __init__(self):
        self.spawned = asyncio.Event()
        self._killed = asyncio.Event()

    async def run(self, model, target, on_progress, on_spawn=None):
        if on_spawn is not None:
            on_spawn(self._killed.set)
        self.spawned.set()
        await self._killed.wait()
        return CurationResult(status="error", metrics=_metrics(),
                              failure="simulator produced no result (exit -9)",
                              ran_at="t2")


@pytest.mark.asyncio
async def test_cancel_during_tune_emits_cancelled_and_persists_nothing(mongo_db):
    sio = FakeSio()
    tuner = HangingTunerRunner()
    hub, store, runs = _hub(mongo_db, sio, tuner_runner=tuner,
                            curation_runner=FakeCurationRunner(progress=[], result=_pass_curation()))
    task = asyncio.create_task(hub.generate("g1"))
    await asyncio.wait_for(tuner.spawned.wait(), timeout=2)
    assert hub.cancel_generate("g1") is True
    assert await task is True
    assert sio.phases() == ["tuning", "cancelled"]
    assert sio.count("tuning_failed") == 0
    assert sio.count("run_complete") == 0
    assert await runs.list_for_game("g1") == []
    assert (await store.get("g1")).tune_result is None
    assert hub.cancel_generate("g1") is False  # reservation freed


@pytest.mark.asyncio
async def test_cancel_during_verify_emits_cancelled_and_records_no_run(mongo_db):
    sio = FakeSio()
    cur = HangingCurationRunner()
    hub, _, runs = _hub(mongo_db, sio,
                        tuner_runner=FakeTunerRunner(progress=[], result=_pass_tune()),
                        curation_runner=cur)
    task = asyncio.create_task(hub.generate("g1"))
    await asyncio.wait_for(cur.spawned.wait(), timeout=2)
    assert hub.cancel_generate("g1") is True
    assert await task is True
    assert sio.phases() == ["tuning", "verifying", "cancelled"]
    assert sio.count("run_complete") == 0
    assert await runs.list_for_game("g1") == []


@pytest.mark.asyncio
async def test_cancel_before_spawn_kills_on_registration(mongo_db):
    sio = FakeSio()
    tuner = SlowSpawnTunerRunner()
    hub, _, runs = _hub(mongo_db, sio, tuner_runner=tuner,
                        curation_runner=FakeCurationRunner(progress=[], result=_pass_curation()))
    task = asyncio.create_task(hub.generate("g1"))
    await asyncio.sleep(0)  # let the pipeline reserve + park before spawn
    assert hub.cancel_generate("g1") is True   # no kill callable yet: flag-only
    tuner.release_spawn.set()                  # spawn now registers → killed at once
    assert await task is True
    assert sio.phases() == ["tuning", "cancelled"]
    assert await runs.list_for_game("g1") == []


@pytest.mark.asyncio
async def test_cancel_without_active_run_returns_false(mongo_db):
    hub, _, _ = _hub(mongo_db, FakeSio(),
                     tuner_runner=FakeTunerRunner(progress=[], result=_pass_tune()),
                     curation_runner=FakeCurationRunner(progress=[], result=_pass_curation()))
    assert hub.cancel_generate("nope") is False
```

Also update the file's existing local doubles to accept the new keyword the hub now always passes: add `, on_spawn=None` to the `run` signatures of `GatedTunerRunner`, `RaisingTunerRunner`, and `RecordingCurationRunner`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run --directory studio/backend pytest tests/test_math_generate.py -v`
Expected: the four new tests FAIL (`AttributeError: 'MathHub' object has no attribute 'cancel_generate'`); existing tests still pass.

- [ ] **Step 3: Implement in `hub.py`**

Add `from typing import Callable` to the imports. In `__init__`, after `self._active`:

```python
        self._cancelled: set[str] = set()   # cancel requested for an active pipeline
        self._cancels: dict[str, Callable[[], None]] = {}  # live kill per game
```

New methods (place next to `_reserve`):

```python
    def cancel_generate(self, game_id: str) -> bool:
        """Request cancellation of an in-flight generate pipeline. Discards
        everything: kills the live subprocess (if any) now, and the flag aborts
        the pipeline at its next phase boundary. False if nothing is running."""
        if game_id not in self._active:
            return False
        self._cancelled.add(game_id)
        kill = self._cancels.get(game_id)
        if kill is not None:
            kill()
        return True

    def _register_kill(self, game_id: str) -> Callable[[Callable[[], None]], None]:
        def register(kill: Callable[[], None]) -> None:
            self._cancels[game_id] = kill
            if game_id in self._cancelled:
                kill()  # cancel arrived before the subprocess spawned
        return register
```

`request_tune`: pass the hook and guard the post-run persistence/emit. Replace

```python
        result = await self._tuner_runner.run(model, target, config,
                                              on_progress=sync_progress)
        if pending:
            await asyncio.gather(*pending)
        await self._store.save_tune_result(game_id, result)

        if result.status not in ("pass", "near_miss"):
```

with

```python
        result = await self._tuner_runner.run(model, target, config,
                                              on_progress=sync_progress,
                                              on_spawn=self._register_kill(game_id))
        if pending:
            await asyncio.gather(*pending)
        self._cancels.pop(game_id, None)
        if game_id in self._cancelled:
            return result  # cancelled: discard — no save, no tuning_failed
        await self._store.save_tune_result(game_id, result)

        if result.status not in ("pass", "near_miss"):
```

`_verify_tuned`: same hook on the curate call — replace

```python
        return await self._curation_runner.run(tuned_model, target,
                                               on_progress=_noop)
```

with

```python
        try:
            return await self._curation_runner.run(
                tuned_model, target, on_progress=_noop,
                on_spawn=self._register_kill(game_id))
        finally:
            self._cancels.pop(game_id, None)
```

`_generate_reserved`: check the flag at both phase boundaries, classify exceptions, clean up. After the `duration_ms = ...` line insert:

```python
            if game_id in self._cancelled:
                await self._status(game_id, "cancelled")
                return True
```

After the `verify = await self._verify_tuned(...)` line insert the same three lines. In the `except Exception:` block, before `logger.exception(...)`:

```python
            if game_id in self._cancelled:
                await self._status(game_id, "cancelled")
                return True
```

And the `finally:` becomes:

```python
        finally:
            self._active.discard(game_id)
            self._cancelled.discard(game_id)
            self._cancels.pop(game_id, None)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run --directory studio/backend pytest tests/test_math_generate.py tests/test_math_hub.py tests/test_math_rest.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/math/hub.py studio/backend/tests/test_math_generate.py
git commit -m "feat(math): MathHub.cancel_generate — kill in-flight pipeline, emit cancelled"
```

---

### Task 3: REST cancel route

**Files:**

- Modify: `studio/backend/app/math/rest.py` (below `generate_math`:109)
- Test: `studio/backend/tests/test_math_rest.py`

**Interfaces:**

- Consumes: `MathHub.cancel_generate` (Task 2).
- Produces: `POST /games/{game_id}/math/generate/cancel` → 202 accepted / 409 `"no active run"`.

- [ ] **Step 1: Write the failing tests**

Add to `studio/backend/tests/test_math_rest.py` (after the existing generate-route tests, reusing `_generate_hub`, `_req`, `_GatedTunerRunner`, `_pass_tune_result` — and add `, on_spawn=None` to `_GatedTunerRunner.run`'s signature since the hub now passes it):

```python
@pytest.mark.asyncio
async def test_cancel_route_409_when_idle(mongo_db):
    hub = _generate_hub(mongo_db,
                        tuner_runner=FakeTunerRunner(progress=[], result=_pass_tune_result()))
    req = _req(math_hub=hub)
    with pytest.raises(HTTPException) as exc_info:
        await rest.cancel_generate_math("g1", req)
    assert exc_info.value.status_code == 409


@pytest.mark.asyncio
async def test_cancel_route_202_aborts_running_generate(mongo_db):
    gated = _GatedTunerRunner(_pass_tune_result())
    hub = _generate_hub(mongo_db, tuner_runner=gated)
    req = _req(math_hub=hub)

    resp = await rest.generate_math("g1", req)
    assert resp.status_code == 202
    await asyncio.sleep(0)  # let the run reserve + park on the gate

    resp = await rest.cancel_generate_math("g1", req)
    assert resp.status_code == 202
    gated.gate.set()  # runner returns; pipeline sees the flag and cancels
    await asyncio.sleep(0.05)
    with pytest.raises(HTTPException):  # nothing active anymore
        await rest.cancel_generate_math("g1", req)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run --directory studio/backend pytest tests/test_math_rest.py -v`
Expected: new tests FAIL (`AttributeError: module ... has no attribute 'cancel_generate_math'`).

- [ ] **Step 3: Implement in `rest.py`**

Below `generate_math`:

```python
@router.post("/games/{game_id}/math/generate/cancel", status_code=202)
async def cancel_generate_math(game_id: str, request: Request) -> Response:
    if not request.app.state.math_hub.cancel_generate(game_id):
        raise HTTPException(status_code=409, detail="no active run")
    return Response(status_code=202)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run --directory studio/backend pytest tests/test_math_rest.py -v`
Expected: all PASS. Then the whole backend suite: `uv run --directory studio/backend pytest -q` — all PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/math/rest.py studio/backend/tests/test_math_rest.py
git commit -m "feat(math): POST /math/generate/cancel route (202/409)"
```

---

### Task 4: Frontend state + REST client + cancel action

**Files:**

- Modify: `studio/frontend/src/plugins/math/state.ts:203` (genStatus union)
- Modify: `studio/frontend/src/plugins/math/restClient.ts` (below `generate`:66)
- Modify: `studio/frontend/src/plugins/math/actions.ts` (below `generateMath`:114)
- Test: `studio/frontend/src/plugins/math/restClient.spec.ts`, `studio/frontend/src/plugins/math/actions.spec.ts`

**Interfaces:**

- Consumes: Task 3's route.
- Produces: `genStatus` union gains `'cancelling' | 'cancelled'`; `cancelGenerate(gameId): Promise<'accepted' | 'idle'>` ('idle' = 409); `cancelMath(): Promise<void>` action.

- [ ] **Step 1: Write the failing tests**

In `restClient.spec.ts`, mirror the file's existing fetch-mock pattern (it stubs `global.fetch`; copy the arrange/assert shape of the `generate` tests):

```ts
describe('cancelGenerate', () => {
  it('POSTs to the cancel route and returns accepted on 202', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetchMock);
    await expect(cancelGenerate('g1')).resolves.toBe('accepted');
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/games/g1/math/generate/cancel'), { method: 'POST' });
  });

  it('returns idle on 409 without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409 }));
    await expect(cancelGenerate('g1')).resolves.toBe('idle');
  });

  it('throws on other failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(cancelGenerate('g1')).rejects.toThrow('request failed: 500');
  });
});
```

In `actions.spec.ts`, mirror the file's existing module-mock pattern for `./restClient` (add `cancelGenerate` to the mocked module) and add:

```ts
describe('cancelMath', () => {
  it('sets cancelling and leaves the rest to the socket event on accepted', async () => {
    mathSlice().activeGameId.set('g1');
    mathSlice().genStatus.set('tuning');
    cancelGenerateMock.mockResolvedValue('accepted');
    await cancelMath();
    expect(mathSlice().genStatus.get()).toBe('cancelling');
  });

  it('self-heals to idle when the backend reports no active run (409)', async () => {
    mathSlice().activeGameId.set('g1');
    mathSlice().genStatus.set('tuning'); // stuck UI
    cancelGenerateMock.mockResolvedValue('idle');
    await cancelMath();
    expect(mathSlice().genStatus.get()).toBe('idle');
    expect(mathSlice().genProgress.get()).toBeNull();
  });

  it('restores the prior status when the cancel POST itself fails', async () => {
    mathSlice().activeGameId.set('g1');
    mathSlice().genStatus.set('tuning');
    cancelGenerateMock.mockRejectedValue(new Error('network'));
    await cancelMath();
    expect(mathSlice().genStatus.get()).toBe('tuning');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx nx test studio-frontend -- --run src/plugins/math/restClient.spec.ts src/plugins/math/actions.spec.ts`
Expected: FAIL — `cancelGenerate` / `cancelMath` not exported.

- [ ] **Step 3: Implement**

`state.ts:203`:

```ts
genStatus: 'idle' | 'tuning' | 'verifying' | 'done' | 'failed' | 'cancelling' | 'cancelled';
```

`restClient.ts` below `generate`:

```ts
export async function cancelGenerate(gameId: string): Promise<'accepted' | 'idle'> {
  const res = await fetch(`${BACKEND_URL}/games/${gameId}/math/generate/cancel`, { method: 'POST' });
  if (res.status === 409) return 'idle'; // no active run — caller self-heals
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return 'accepted';
}
```

`actions.ts` below `generateMath` (add `cancelGenerate` to the `./restClient` import list):

```ts
export async function cancelMath(): Promise<void> {
  const s = mathSlice();
  const gameId = s.activeGameId.get();
  if (!gameId) return;
  const prev = s.genStatus.get();
  s.genStatus.set('cancelling');
  try {
    const outcome = await cancelGenerate(gameId);
    if (outcome === 'idle') {
      // Backend has no active run — the UI was stuck; reset to reality.
      s.genStatus.set('idle');
      s.genProgress.set(null);
    }
    // 'accepted': stay in 'cancelling' until generate_status:cancelled lands.
  } catch {
    s.genStatus.set(prev); // POST failed; the run is still going
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx nx test studio-frontend -- --run src/plugins/math/restClient.spec.ts src/plugins/math/actions.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/math/state.ts studio/frontend/src/plugins/math/restClient.ts studio/frontend/src/plugins/math/actions.ts studio/frontend/src/plugins/math/restClient.spec.ts studio/frontend/src/plugins/math/actions.spec.ts
git commit -m "feat(math): cancelMath action + cancelGenerate REST client with 409 self-heal"
```

---

### Task 5: Socket `cancelled` handler + GenerateBar toggle

**Files:**

- Modify: `studio/frontend/src/plugins/math/socketClient.ts:57` (generate_status handler)
- Modify: `studio/frontend/src/plugins/math/components/GenerateBar.tsx`
- Test: `studio/frontend/src/plugins/math/socketClient.spec.ts`, `studio/frontend/src/plugins/math/components/GenerateBar.spec.tsx`

**Interfaces:**

- Consumes: `cancelMath` (Task 4), backend `generate_status: {phase: 'cancelled'}` (Task 2).
- Produces: `data-testid="cancel-button"` (label `Cancel`, or `Cancelling…` disabled while `genStatus === 'cancelling'`); `generate-status` text `run cancelled`; `generate-button` hidden while the pipeline runs.

- [ ] **Step 1: Write the failing tests**

`socketClient.spec.ts` — the file registers handlers into a module-level `handlers` record via a mocked `io()`; fire them directly (its `beforeEach` already sets `activeGameId` to `'g1'`):

```ts
it('generate_status cancelled resets progress and sets genStatus', () => {
  createMathSocket().connect();
  mathSlice().genStatus.set('cancelling');
  mathSlice().genProgress.set({ generation: 3, maxGenerations: 40 });
  handlers['generate_status']({ gameId: 'g1', phase: 'cancelled' });
  expect(mathSlice().genStatus.get()).toBe('cancelled');
  expect(mathSlice().genProgress.get()).toBeNull();
});
```

`GenerateBar.spec.tsx` — the existing test `'disables generate + verify while genStatus is tuning'` changes meaning: while tuning, `generate-button` is REPLACED by `cancel-button`. Rewrite it and add the new cases (also add `cancelMath: () => cancelMath()` to the `vi.mock('../actions', ...)` block with its own `const cancelMath = vi.fn()`):

```ts
  it('swaps Generate for an enabled Cancel while tuning; verify stays disabled', () => {
    mathSlice().genStatus.set('tuning');
    render(<GenerateBar />);
    expect(screen.queryByTestId('generate-button')).toBeNull();
    expect((screen.getByTestId('cancel-button') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('verify-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows Cancel even when all sections are locked (cancel is never gated)', () => {
    mathSlice().genStatus.set('verifying');
    mathSlice().locks.set({ reels: true, paytable: true, bonus: true });
    render(<GenerateBar />);
    expect((screen.getByTestId('cancel-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('calls cancelMath when Cancel is clicked', () => {
    mathSlice().genStatus.set('tuning');
    render(<GenerateBar />);
    fireEvent.click(screen.getByTestId('cancel-button'));
    expect(cancelMath).toHaveBeenCalled();
  });

  it('shows a disabled Cancelling… button while cancelling', () => {
    mathSlice().genStatus.set('cancelling');
    render(<GenerateBar />);
    const btn = screen.getByTestId('cancel-button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe('Cancelling…');
  });

  it('shows run cancelled in the status line and restores Generate after cancel', () => {
    mathSlice().genStatus.set('cancelled');
    render(<GenerateBar />);
    expect(screen.getByTestId('generate-status').textContent).toBe('run cancelled');
    expect((screen.getByTestId('generate-button') as HTMLButtonElement).disabled).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx nx test studio-frontend -- --run src/plugins/math/socketClient.spec.ts src/plugins/math/components/GenerateBar.spec.tsx`
Expected: FAIL — no `cancel-button`, no `cancelled` handling.

- [ ] **Step 3: Implement**

`socketClient.ts` — widen the phase type and clear progress on cancel:

```ts
sock.on('generate_status', (p: { gameId: string; phase: 'tuning' | 'verifying' | 'done' | 'failed' | 'cancelled' }) => {
  if (!isActive(p.gameId)) return;
  const s = mathSlice();
  s.genStatus.set(p.phase);
  if (p.phase === 'tuning') {
    // A fresh pipeline: clear the previous run's artifacts so Evolution streams live.
    s.genFailure.set(null);
    s.genProgress.set(null);
    s.applied.set(false);
    s.frames.set([]);
    s.selectedGeneration.set('live');
  }
  if (p.phase === 'cancelled') s.genProgress.set(null);
  if (p.phase === 'done') void refreshTuneResult(p.gameId);
});
```

`GenerateBar.tsx` — import `cancelMath`, derive the pipeline states, swap the button, extend the status text:

```tsx
import { generateMath, verifyMath, cancelMath } from '../actions';
```

```tsx
const genRunning = genStatus === 'tuning' || genStatus === 'verifying';
const cancelling = genStatus === 'cancelling';
const running = genRunning || cancelling || verifyStatus === 'running';
```

Status text — extend the chain (`cancelling` shows nothing extra; the button already says Cancelling…):

```tsx
          : genStatus === 'failed'
            ? 'failed'
            : genStatus === 'cancelled'
              ? 'run cancelled'
              : '';
```

Button swap — replace the single Generate `<button>` with:

```tsx
{
  genRunning || cancelling ? (
    <button
      data-testid="cancel-button"
      onClick={() => void cancelMath()}
      disabled={cancelling}
      className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
    >
      {cancelling ? 'Cancelling…' : 'Cancel'}
    </button>
  ) : (
    <button
      data-testid="generate-button"
      onClick={() => void generateMath()}
      disabled={running || locked || !!gap}
      className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
    >
      Generate
    </button>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx nx test studio-frontend -- --run src/plugins/math` then the full four frontend gates (prettier check, typecheck, test, build).
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/math/socketClient.ts studio/frontend/src/plugins/math/components/GenerateBar.tsx studio/frontend/src/plugins/math/socketClient.spec.ts studio/frontend/src/plugins/math/components/GenerateBar.spec.tsx
git commit -m "feat(math): Generate button toggles to Cancel; handle generate_status cancelled"
```

---

### Task 6: Playwright e2e — cancel round-trip

**Files:**

- Modify: `studio/frontend/e2e/math-plugin.spec.ts`

**Interfaces:**

- Consumes: everything above, running against the replay stack on the worktree's offset ports.

- [ ] **Step 1: Write the test**

Add to `math-plugin.spec.ts` (after the existing tests, reusing `setupGame`, `openMath`, `DETUNED`, `FAST_TUNER_PARAMS`, `BACKEND`):

```ts
// Heavy search params: ~64×2M spins per generation keeps the GA busy for well
// over a minute (watchdog cap is 120s) — a deterministic window to cancel into.
const SLOW_TUNER_PARAMS = {
  ...FAST_TUNER_PARAMS,
  population: 64,
  maxGenerations: 100000,
  stagnationWindow: 100000,
  searchCandidateCount: 2000000,
};

test('cancel: Generate toggles to Cancel, aborts the run, persists nothing', async ({ page, request }) => {
  const gameId = await setupGame(page, request, 'canceluser', 'cancel room', {
    model: DETUNED,
    tunerParams: SLOW_TUNER_PARAMS,
    intent: { rtp: '90%', volatility: 'medium' },
  });
  await openMath(page);

  await page.getByTestId('generate-button').click();
  await expect(page.getByTestId('generate-status')).toContainText('tuning', { timeout: 15_000 });
  await expect(page.getByTestId('cancel-button')).toBeEnabled();

  await page.getByTestId('cancel-button').click();
  await expect(page.getByTestId('generate-status')).toContainText('run cancelled', { timeout: 30_000 });
  await expect(page.getByTestId('generate-button')).toBeEnabled();

  // Discard semantics: no run was persisted.
  const runs = await request.get(`${BACKEND}/analytics/runs?game_id=${gameId}`);
  expect(await runs.json()).toEqual([]);
});
```

- [ ] **Step 2: Run the e2e suite against the worktree's replay stack**

From the worktree root (offset 1 — NEVER the default ports; export the offset so Playwright doesn't silently attach to another session's stack):

```bash
cargo build --release -p bloom-simulator -p bloom-tuner   # fast subprocess spawns
just backend-serve-replay   # background; backend on :8001
just e2e -- math-plugin.spec.ts
```

Expected: the new test passes — status reaches `run cancelled` in seconds (kill is immediate), Generate returns, runs list empty. Run the whole `math-plugin.spec.ts` file to prove the existing generate/apply flows still pass.

- [ ] **Step 3: Commit**

```bash
git add studio/frontend/e2e/math-plugin.spec.ts
git commit -m "test(math): e2e cancel round-trip — toggle, abort, nothing persisted"
```

---

### Task 7: Full gates + PR

- [ ] **Step 1: Backend suite**

`uv run --directory studio/backend pytest -q` — all green.

- [ ] **Step 2: Frontend gates (all four)**

```bash
node_modules/.bin/prettier --check .
npx nx typecheck studio-frontend
npx nx test studio-frontend
npx nx build studio-frontend
```

All green (vitest green alone is NOT sufficient — typecheck has caught what vitest masked before).

- [ ] **Step 3: Full Playwright e2e**

`just e2e` from the worktree (replay backend on :8001 running). All green.

- [ ] **Step 4: Push + PR**

```bash
git push -u origin feat/math-generate-cancel
gh pr create --title "feat(math): Generate button toggles to Cancel — abort in-flight runs" --body "..."
```

PR body: summarize spec decision (discard semantics, on-demand watchdog kill), list the test evidence (backend cancel tests, GenerateBar/socket/action vitest, e2e cancel round-trip), link the spec file.

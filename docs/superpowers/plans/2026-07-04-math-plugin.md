# Math Plugin (SP3, math-consolidation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One **Math** pane (target strip → Generate → live analytics tabs → result strip + Apply → advanced expander) replaces the Simulator, Tuner, and Math Analytics panes; the three plugins, their e2e specs, and the backend routes/events that lose their last consumer are deleted in the same PR.

**Architecture:** Grow the existing `math-analytics` plugin into `math` (git mv — the four tabs, charts, RunSelector, and socket/state plumbing carry over verbatim), then add the strips around the tabs. Backend is already done (SP1/SP2) except two small changes: snapshot `locks` onto `math_runs`, and prune dead surface. Spec: `docs/superpowers/specs/2026-07-03-math-consolidation-design.md` — Sub-project 3 + "SP3 brainstorm resolutions".

**Tech Stack:** React 18 + hookstate + socket.io-client + uPlot (all existing), FastAPI + Motor backend, Playwright e2e, vitest + pytest.

## Global Constraints

- **Worktree:** all work in `C:\code\bloom.wt\math-plugin` (branch `feat/math-plugin`), never the primary checkout. `BLOOM_PORT_OFFSET=1` → backend :8001, frontend :4201, Mongo db `bloom_studio_wt1`. NEVER use :8000/:4200 (another session owns them).
- **Bootstrap once** (if `node_modules` missing): `npm install` at worktree root; `uv --directory studio/backend sync`. Shared `mongod` on :27017 must be running.
- `just` may fail with "could not find the shell `sh`" — every `just` recipe used here has its inline fallback below.
- **TypeScript interfaces use an `I` prefix** (`docs/coding-standards.md`). Follow `docs/design-language.md`: no raw colors, only the token classes already used in `studio/frontend` (`bg-surface`, `border-hairline`, `text-text-1/2/3`, `text-success`, `text-warning`, `text-danger`, `bg-canvas`, `hover:bg-raised-hover`, accent tokens). A guard test blocks raw colors.
- **Semantic commits** (`feat(math): …`, `test: …`, `refactor: …`).
- **Frontend gates before every push** (all four, from worktree root):
  `node_modules/.bin/prettier --check .` · `npx nx run frontend:typecheck` · `npx nx run frontend:test` · `npx nx run frontend:build`
- **Backend tests:** `uv --directory studio/backend run pytest -q` (single file: append the path).
- **Vitest single file:** `npx vitest run <relative spec> --dir studio/frontend` or run the full `npx nx run frontend:test`.
- **Socket/REST names are frozen** except the explicit deletions in Task 10 — chat tools and replay cassettes depend on them.
- Wire shapes used throughout (verified against merged source):
  - `GET/PUT /games/{id}/slot-model` → `sim_wire`: `{id, gameId, model, params (ICurationParams camelCase), tunerParams, locks {reels,paytable,bonus}, presentation, result (ICurationResult|null), createdAt, updatedAt}`.
  - `GET /games/{id}/tuner` → `tuner_view`: `{id, gameId, params (ITuningParams), result (ITuneResult|null), createdAt, updatedAt}`.
  - `GET /games/{id}/tuner/target` → `{target: {...snake_case: rtp_target, rtp_tolerance, volatility_min, volatility_max, bonus_hit_rate_bands}}` or `{gap: string}` (plain dict — NOT camelized).
  - `GET /games/{id}/gdd/docs` → array of `{id, gameId, aspect, title, order, data, body, status, createdAt, updatedAt}`; `PUT /games/{id}/gdd/{aspect}` body `{fields: {...}}` → `{doc, warnings, rebuilt}`. math-model `data` keys: `rtp`, `volatility`, `bonus_hit_rate` (snake, inside opaque `data`).
  - Socket (room = gameId; any `join_*` puts THIS connection in the room, after which ALL room events arrive): `generate_status {gameId, phase: tuning|verifying|done|failed}`, `analytics_progress {gameId, generation, maxGenerations, best, population, geneAgreement}`, `run_complete {gameId, run}`, `tuning_failed {gameId, failure}`, `curation_progress {gameId, phase, done, total}`, `curation_complete {gameId, doc: sim_wire}`, `curation_failed {gameId, failure}`, `slot_model_changed {gameId, updatedAt, source}`, `gdd_doc_updated {gameId, doc}`.
  - Volatility enum: `low | medium | medium-high | high` (`app/math/targets.py:VOLATILITY_BANDS`).

---

### Task 1: Backend — snapshot `locks` onto `math_runs`

The result strip shows "which sections were locked for the run"; the run doc must carry them.

**Files:**

- Modify: `studio/backend/app/math/models.py` (MathRunDoc, ~line 198)
- Modify: `studio/backend/app/math/hub.py` (`record_run` ~line 244, `_generate_reserved` ~line 195)
- Test: `studio/backend/tests/test_math_generate.py`

**Interfaces:**

- Produces: `MathRunDoc.locks: SectionLocks | None` → wire key `locks: {reels, paytable, bonus} | null` in `math_run_wire` / `run_complete` payloads. Frontend Task 3 types this as `IMathRun.locks`.

- [ ] **Step 1: Write the failing test.** Open `studio/backend/tests/test_math_generate.py`, copy the exact setup of `test_generate_runs_tune_then_verify_and_persists_one_run` (same fakes/fixtures — mirror the merged source, don't invent), and add:

```python
async def test_generate_snapshots_locks_onto_the_run(mongo_db):
    # same store/runs/hub construction as test_generate_runs_tune_then_verify_and_persists_one_run
    ...
    await store.put("g1", locks=SectionLocks(bonus=True))
    ok = await hub.generate("g1")
    assert ok is True
    saved = (await runs.list_for_game("g1"))[0]
    assert saved.locks is not None
    assert saved.locks.bonus is True and saved.locks.reels is False and saved.locks.paytable is False
```

Import `SectionLocks` from `app.math.models` at the top if not already imported.

- [ ] **Step 2: Run it — expect FAIL** (`MathRunDoc` has no `locks`, `record_run` takes no such arg):
      `uv --directory studio/backend run pytest tests/test_math_generate.py::test_generate_snapshots_locks_onto_the_run -q`

- [ ] **Step 3: Implement.** In `models.py`, add to `MathRunDoc` (after `verify`):

```python
    locks: SectionLocks | None = None  # SP3: lock set the run was tuned with
```

In `hub.py` `record_run`, add parameter and pass-through:

```python
    async def record_run(self, game_id: str, params: TuningParams,
                         result: TuneResult, duration_ms: int,
                         verify: CurationResult | None = None,
                         locks: SectionLocks | None = None) -> MathRunDoc | None:
        ...
        doc = MathRunDoc(
            id=str(uuid.uuid4()), game_id=game_id, params=params,
            verdict=result.verdict, metrics=result.metrics, trace=result.trace,
            profile=result.profile, verify=verify, locks=locks,
            created_at=_now(), duration_ms=duration_ms,
        )
```

Import `SectionLocks` in hub.py's models import. In `_generate_reserved`, the params-capture line becomes a doc capture:

```python
            doc0 = await self._store.get_or_seed(game_id)
            params = doc0.tuner_params
            locks = doc0.locks
```

and the record call becomes `await self.record_run(game_id, params, result, duration_ms, verify=verify, locks=locks)`. (Leave `request_tune`'s own `record=True` path passing no locks — that path is deleted in Task 10.)

- [ ] **Step 4: Run the whole backend math suite — expect PASS:**
      `uv --directory studio/backend run pytest tests/test_math_generate.py tests/test_math_models.py tests/test_math_hub.py -q`

- [ ] **Step 5: Commit:** `git commit -m "feat(math): snapshot section locks onto math_runs docs"`

---

### Task 2: Frontend — rename `math-analytics` → `math` (plugin id, pane id, exports)

Pure mechanical rename; no behavior change. Everything compiles and all existing vitest specs stay green (renamed, not rewritten).

**Files:**

- Rename: `git mv studio/frontend/src/plugins/math-analytics studio/frontend/src/plugins/math`
- Rename: inside it, `git mv MathAnalyticsPane.tsx MathPane.tsx`, `git mv MathAnalyticsPane.spec.tsx MathPane.spec.tsx`
- Modify: every file inside `studio/frontend/src/plugins/math/`, plus `studio/frontend/src/plugins/index.ts`, `studio/frontend/src/app/routes/RoomRoute.tsx`, `studio/frontend/src/app/routes/RoomRoute.spec.tsx`

**Interfaces (produces — used by every later task):**

- `state.ts`: `MATH_PLUGIN_ID = 'math'`, `mathHooks`, `mathSlice()`, `IMathState` (renamed from `MATH_ANALYTICS_PLUGIN_ID`/`analyticsHooks`/`analyticsSlice`/`IAnalyticsState`; all other exported types keep their names).
- `actions.ts`: `initMath()`, `openGameMath(gameId)`, `closeGameMath()` (renamed from `initAnalytics`/`openGameAnalytics`/`closeGameAnalytics`).
- `socketClient.ts`: `mathSock()` with `joinMath(gameId)`/`leaveMath(gameId)` (STILL emitting `join_analytics`/`leave_analytics` — backend names frozen), socket `auth.displayName: 'math'`.
- `index.ts`: plugin `{ id: MATH_PLUGIN_ID, title: 'Math', panes: [{ id: 'math/viewer', title: 'Math', component: MathPane }], commands: [{ id: 'math/open-viewer', title: 'Open Math', run: (host) => host.openPane('math/viewer') }], init: () => initMath() }` exported as `math`.
- Pane component `MathPane`; the no-game placeholder testid becomes `math-no-game`; the header label text becomes `Math`. All other testids (`analytics-tab-*`, chart testids) are intentionally unchanged.

- [ ] **Step 1:** Do the two `git mv` operations above.
- [ ] **Step 2:** Project-wide search/replace, scoped to `studio/frontend/src`: `MATH_ANALYTICS_PLUGIN_ID`→`MATH_PLUGIN_ID`, `'math-analytics'`→`'math'` (the plugin-id literal in `state.ts` only), `analyticsHooks`→`mathHooks`, `analyticsSlice`→`mathSlice`, `IAnalyticsState`→`IMathState`, `initAnalytics`→`initMath`, `openGameAnalytics`→`openGameMath`, `closeGameAnalytics`→`closeGameMath`, `analyticsSock`→`mathSock`, `createAnalyticsSocket`→`createMathSocket`, `joinAnalytics`→`joinMath`, `leaveAnalytics`→`leaveMath`, `MathAnalyticsPane`→`MathPane`, `mathAnalytics`→`math` (plugin export). Update pane id `'math-analytics/viewer'`→`'math/viewer'`, command id, titles `'Math Analytics'`→`'Math'`, testid `analytics-no-game`→`math-no-game`, `auth: { displayName: 'math-analytics' }`→`'math'`. Fix the import paths in `plugins/index.ts` (`./math`), `RoomRoute.tsx` (`../../plugins/math/actions`), and `RoomRoute.spec.tsx` (mock path + mock names).
- [ ] **Step 3: Gates — expect all green (rename only):** `node_modules/.bin/prettier --write .` then `npx nx run frontend:typecheck && npx nx run frontend:test`
- [ ] **Step 4: Commit:** `git commit -m "refactor(math): rename math-analytics plugin to math (id math/viewer)"`

---

### Task 3: Math state — new fields, wire types, outcome reducers

**Files:**

- Modify: `studio/frontend/src/plugins/math/state.ts`
- Modify: `studio/frontend/src/plugins/math/reducers.ts`
- Test: `studio/frontend/src/plugins/math/reducers.spec.ts`

**Interfaces:**

- Consumes: Task 2's renamed `IMathState`/`mathSlice`.
- Produces (used by Tasks 4–8): types `ISectionLocks`, `ICurationParams`, `ICurationResult`, `IBandMiss`, `ITuneResult`, `ITargetSpec`, `ITargetFields`; `IMathRun` gains `verify: ICurationResult | null` and `locks: ISectionLocks | null`; `IMathState` gains the fields below; reducers `latestOutcome`, `outcomeVerdict`, `allLocked`, type `IOutcome`.

- [ ] **Step 1: Write failing reducer tests** — append to `reducers.spec.ts` (mirror the file's existing fixture style for `IMathRun` objects; a minimal run needs `id/gameId/params/verdict/metrics/trace/profile/createdAt/durationMs` + new `verify/locks`):

```ts
import { latestOutcome, outcomeVerdict, allLocked } from './reducers';

describe('latestOutcome', () => {
  it('returns null with no runs and no verify result', () => {
    expect(latestOutcome({ runs: [], verifyResult: null })).toBeNull();
  });
  it('prefers the newest of run vs verify-only result by timestamp', () => {
    const run = makeRun({ id: 'r1', createdAt: '2026-07-04T10:00:00Z' });
    const verify = makeCuration({ ranAt: '2026-07-04T11:00:00Z' });
    expect(latestOutcome({ runs: [run], verifyResult: verify })).toEqual({ kind: 'verify', result: verify });
    const older = makeCuration({ ranAt: '2026-07-04T09:00:00Z' });
    expect(latestOutcome({ runs: [run], verifyResult: older })).toEqual({ kind: 'run', run });
  });
});

describe('outcomeVerdict', () => {
  it('uses the independent verify verdict of a run when present, else the GA verdict', () => {
    const failedVerify = makeRun({ verdict: 'pass', verify: makeCuration({ status: 'fail' }) });
    expect(outcomeVerdict({ kind: 'run', run: failedVerify })).toBe('fail');
    const noVerify = makeRun({ verdict: 'near_miss', verify: null });
    expect(outcomeVerdict({ kind: 'run', run: noVerify })).toBe('near_miss');
  });
});

describe('allLocked', () => {
  it('is true only when all three sections are locked', () => {
    expect(allLocked({ reels: true, paytable: true, bonus: true })).toBe(true);
    expect(allLocked({ reels: true, paytable: true, bonus: false })).toBe(false);
    expect(allLocked(null)).toBe(false);
  });
});
```

Define local `makeRun`/`makeCuration` helpers in the spec (spread-override pattern over a complete literal).

- [ ] **Step 2: Run — expect FAIL** (functions don't exist): `npx vitest run src/plugins/math/reducers.spec.ts --dir studio/frontend`
- [ ] **Step 3: Implement.** In `state.ts` add:

```ts
export interface ISectionLocks {
  reels: boolean;
  paytable: boolean;
  bonus: boolean;
}

export interface ICurationParams {
  poolSize: number;
  candidateCount: number;
  masterSeed: number;
  rtpTolerance: number;
  realizedCorrectionBand: number;
  bonusRateTolerance: number;
}

export interface ICurationResult {
  status: 'pass' | 'fail' | 'error';
  metrics: IMetrics;
  realizedRtp: number | null;
  poolSize: number | null;
  failure: string | null;
  ranAt: string;
}

export interface IBandMiss {
  metric: string;
  measured: number;
  bandLo: number;
  bandHi: number;
}

export interface ITuneResult {
  status: 'pass' | 'near_miss' | 'error';
  verdict: 'pass' | 'near_miss' | null;
  tunedModel: unknown | null;
  metrics: IMetrics | null;
  missed: IBandMiss[];
  failure: string | null;
  ranAt: string;
}

/** Snake_case on the wire — `derive_target` returns a plain dict (no camel aliasing). */
export interface ITargetSpec {
  rtp_target: number;
  rtp_tolerance: number;
  volatility_min: number;
  volatility_max: number;
  bonus_hit_rate_bands: { min: number; max: number }[];
}

/** Raw editable strings mirrored from the GDD math-model `data` dict. */
export interface ITargetFields {
  rtp: string;
  volatility: string;
  bonusHitRate: string;
}
```

Add to `IMathRun`: `verify: ICurationResult | null;` and `locks: ISectionLocks | null;` (both nullable — pre-SP3 runs have null). Add to `IMathState` and `makeInitialState()`:

```ts
  // target strip
  targetFields: ITargetFields | null;      // null until hydrated
  gddWatermark: string;                    // updatedAt of last seen math-model doc
  derivedTarget: ITargetSpec | null;
  targetGap: string | null;
  targetSaveStatus: 'idle' | 'saving' | 'saved' | 'error';
  // generate pipeline
  genStatus: 'idle' | 'tuning' | 'verifying' | 'done' | 'failed';
  genProgress: { generation: number; maxGenerations: number } | null;
  genFailure: string | null;
  // verify-only (curation of the stored model)
  verifyStatus: 'idle' | 'running' | 'pass' | 'fail' | 'error';
  verifyProgress: { phase: string; done: number | null; total: number | null } | null;
  verifyResult: ICurationResult | null;
  verifyFailure: string | null;
  // apply
  tuneResult: ITuneResult | null;          // pending tuned model (enables Apply)
  applied: boolean;
  // doc-derived
  locks: ISectionLocks | null;
  tunerParams: ITuningParams | null;
  curationParams: ICurationParams | null;
```

Initial values: `targetFields: null`, `gddWatermark: ''`, `derivedTarget: null`, `targetGap: null`, `targetSaveStatus: 'idle'`, `genStatus: 'idle'`, `genProgress: null`, `genFailure: null`, `verifyStatus: 'idle'`, `verifyProgress: null`, `verifyResult: null`, `verifyFailure: null`, `tuneResult: null`, `applied: false`, `locks: null`, `tunerParams: null`, `curationParams: null`.

In `reducers.ts` add:

```ts
import type { ICurationResult, IMathRun, IMathState, ISectionLocks } from './state';

/** The result strip is PINNED TO LATEST (spec: tabs = analysis, strip = current
 * state): newest of the last recorded generate run vs the last verify-only
 * curation of the stored model. Never the RunSelector's browsed run. */
export type IOutcome = { kind: 'run'; run: IMathRun } | { kind: 'verify'; result: ICurationResult } | null;

export function latestOutcome(state: Pick<IMathState, 'runs' | 'verifyResult'>): IOutcome {
  const run = state.runs[0] ?? null; // runs are newest-first (runLoaded prepends)
  const verify = state.verifyResult;
  if (run && verify) return verify.ranAt > run.createdAt ? { kind: 'verify', result: verify } : { kind: 'run', run };
  if (run) return { kind: 'run', run };
  return verify ? { kind: 'verify', result: verify } : null;
}

export function outcomeVerdict(outcome: IOutcome): 'pass' | 'fail' | 'near_miss' | 'error' | null {
  if (!outcome) return null;
  if (outcome.kind === 'verify') return outcome.result.status;
  return outcome.run.verify ? outcome.run.verify.status : outcome.run.verdict;
}

export function allLocked(locks: ISectionLocks | null): boolean {
  return !!locks && locks.reels && locks.paytable && locks.bonus;
}
```

- [ ] **Step 4: Run — expect PASS**, then full `npx nx run frontend:typecheck && npx nx run frontend:test`.
- [ ] **Step 5: Commit:** `git commit -m "feat(math): state fields + outcome reducers for the unified pane"`

---

### Task 4: restClient — the pane's full REST surface

**Files:**

- Modify: `studio/frontend/src/plugins/math/restClient.ts`
- Test: `studio/frontend/src/plugins/math/restClient.spec.ts`

**Interfaces:**

- Consumes: Task 3 types.
- Produces (used by Tasks 5–8): `ISlotModelWire`, `ITunerWire`, `IGddDocWire` and functions `getSlotModel(gameId)`, `putCurationParams(gameId, params)`, `curate(gameId)`, `generate(gameId)`, `getTuner(gameId)`, `putTunerParams(gameId, params)`, `applyTuned(gameId)`, `getTarget(gameId)`, `getGddDocs(gameId)`, `putMathModelFields(gameId, fields)`. Existing `fetchRuns`/`fetchRun` unchanged.

- [ ] **Step 1: Write failing tests** — extend `restClient.spec.ts` following its existing mocked-`fetch` pattern (assert URL, method, JSON body, parsed return). Cover at minimum: `generate` POSTs `/games/g1/math/generate` and throws on 409; `putMathModelFields` PUTs `/games/g1/gdd/math-model` with body `{fields}` and returns `res.doc`; `getTarget` returns `{gap}` untouched; `putTunerParams` PUTs `{params}`.
- [ ] **Step 2: Run — expect FAIL:** `npx vitest run src/plugins/math/restClient.spec.ts --dir studio/frontend`
- [ ] **Step 3: Implement** — append to `restClient.ts` (reuse its existing `okJson` helper):

```ts
import type { ICurationParams, ICurationResult, ISectionLocks, ITargetSpec, ITuneResult, ITuningParams } from './state';

export interface ISlotModelWire {
  id: string;
  gameId: string;
  model: unknown;
  params: ICurationParams;
  locks: ISectionLocks;
  result: ICurationResult | null;
  updatedAt: string;
}

export interface ITunerWire {
  id: string;
  gameId: string;
  params: ITuningParams;
  result: ITuneResult | null;
  updatedAt: string;
}

export interface IGddDocWire {
  aspect: string;
  data: Record<string, unknown>;
  updatedAt: string;
}

export async function getSlotModel(gameId: string): Promise<ISlotModelWire> {
  return okJson<ISlotModelWire>(await fetch(`${BACKEND_URL}/games/${gameId}/slot-model`));
}

export async function putCurationParams(gameId: string, params: ICurationParams): Promise<ISlotModelWire> {
  return okJson<ISlotModelWire>(
    await fetch(`${BACKEND_URL}/games/${gameId}/slot-model`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params }),
    }),
  );
}

export async function curate(gameId: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/games/${gameId}/slot-model/curate`, { method: 'POST' });
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
}

export async function generate(gameId: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/games/${gameId}/math/generate`, { method: 'POST' });
  if (!res.ok) throw new Error(res.status === 409 ? 'a run is already in progress' : `request failed: ${res.status}`);
}

export async function getTuner(gameId: string): Promise<ITunerWire> {
  return okJson<ITunerWire>(await fetch(`${BACKEND_URL}/games/${gameId}/tuner`));
}

export async function putTunerParams(gameId: string, params: ITuningParams): Promise<ITunerWire> {
  return okJson<ITunerWire>(
    await fetch(`${BACKEND_URL}/games/${gameId}/tuner`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params }),
    }),
  );
}

export async function applyTuned(gameId: string): Promise<ISlotModelWire> {
  return okJson<ISlotModelWire>(await fetch(`${BACKEND_URL}/games/${gameId}/tuner/apply`, { method: 'POST' }));
}

export async function getTarget(gameId: string): Promise<{ target?: ITargetSpec; gap?: string }> {
  return okJson<{ target?: ITargetSpec; gap?: string }>(await fetch(`${BACKEND_URL}/games/${gameId}/tuner/target`));
}

export async function getGddDocs(gameId: string): Promise<IGddDocWire[]> {
  return okJson<IGddDocWire[]>(await fetch(`${BACKEND_URL}/games/${gameId}/gdd/docs`));
}

export async function putMathModelFields(gameId: string, fields: Record<string, unknown>): Promise<IGddDocWire> {
  const res = await okJson<{ doc: IGddDocWire }>(
    await fetch(`${BACKEND_URL}/games/${gameId}/gdd/math-model`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    }),
  );
  return res.doc;
}
```

- [ ] **Step 4: Run — expect PASS**, plus typecheck.
- [ ] **Step 5: Commit:** `git commit -m "feat(math): rest client for slot-model, tuner, target, gdd math-model"`

---

### Task 5: sync helpers + socket extension

**Files:**

- Create: `studio/frontend/src/plugins/math/sync.ts`
- Test: `studio/frontend/src/plugins/math/sync.spec.ts`
- Modify: `studio/frontend/src/plugins/math/socketClient.ts`
- Test: `studio/frontend/src/plugins/math/socketClient.spec.ts`

**Interfaces:**

- Consumes: Task 4 rest functions, Task 3 state fields.
- Produces: `sync.ts` exports `fieldsFromGddData(data)`, `refreshTarget(gameId)`, `refreshDoc(gameId)`, `refreshTuneResult(gameId)` — importable by BOTH `socketClient.ts` and `actions.ts` without an import cycle (sync imports only state + restClient).

- [ ] **Step 1: Write failing tests.** `sync.spec.ts` (mock `./restClient` with `vi.mock`, drive `mathSlice()` directly like `actions.spec.ts` does):

```ts
describe('fieldsFromGddData', () => {
  it('maps math-model data to editable strings, tolerating missing keys and numbers', () => {
    expect(fieldsFromGddData({ rtp: 0.9, volatility: 'low' })).toEqual({ rtp: '0.9', volatility: 'low', bonusHitRate: '' });
    expect(fieldsFromGddData({})).toEqual({ rtp: '', volatility: '', bonusHitRate: '' });
    expect(fieldsFromGddData({ bonus_hit_rate: '1:150' }).bonusHitRate).toBe('1:150');
  });
});

describe('refreshTarget', () => {
  it('stores bands on target and clears the gap', async () => {
    mathSlice().activeGameId.set('g1');
    vi.mocked(getTarget).mockResolvedValue({
      target: { rtp_target: 0.9, rtp_tolerance: 0.02, volatility_min: 0, volatility_max: 3, bonus_hit_rate_bands: [] },
    });
    await refreshTarget('g1');
    expect(mathSlice().derivedTarget.get({ noproxy: true })).toMatchObject({ rtp_target: 0.9 });
    expect(mathSlice().targetGap.get()).toBeNull();
  });
  it('stores a gap and drops responses for a game that is no longer active', async () => {
    mathSlice().activeGameId.set('g1');
    vi.mocked(getTarget).mockResolvedValue({ gap: 'missing rtp' });
    await refreshTarget('g1');
    expect(mathSlice().targetGap.get()).toBe('missing rtp');
    mathSlice().activeGameId.set('g2');
    vi.mocked(getTarget).mockResolvedValue({ gap: 'stale' });
    await refreshTarget('g1'); // resolves after the user switched games
    expect(mathSlice().targetGap.get()).toBe('missing rtp'); // unchanged
  });
});

describe('refreshTuneResult', () => {
  it('skips while a generate is streaming (genStatus tuning/verifying)', async () => {
    mathSlice().activeGameId.set('g1');
    mathSlice().genStatus.set('tuning');
    await refreshTuneResult('g1');
    expect(getTuner).not.toHaveBeenCalled();
  });
  it('hydrates the pending tuned result when idle', async () => {
    mathSlice().activeGameId.set('g1');
    vi.mocked(getTuner).mockResolvedValue({ id: 'd1', gameId: 'g1', params: makeTuningParams(), result: makeTuneResult(), updatedAt: 't1' });
    await refreshTuneResult('g1');
    expect(mathSlice().tuneResult.get({ noproxy: true })).not.toBeNull();
  });
});
```

(`makeTuningParams`/`makeTuneResult` are local complete-literal helpers, same pattern as the reducer spec's `makeRun`.)

````

`socketClient.spec.ts` additions (follow its existing fake-socket pattern):
- `generate_status` `tuning` resets `frames`, `genFailure`, `applied`, sets `genStatus`; `failed`/`done` just set `genStatus`.
- `analytics_progress` also sets `genProgress {generation, maxGenerations}` (existing frame behavior untouched).
- `tuning_failed` sets `genFailure`.
- `curation_progress/complete/failed` drive `verifyStatus/verifyProgress/verifyResult/verifyFailure` (complete also refreshes `locks`/`curationParams` from `p.doc`).
- `gdd_doc_updated` for `math-model` with `updatedAt <= gddWatermark` is ignored; newer one updates `targetFields` + watermark; other aspects ignored.
- events for a non-active game are dropped (existing guard).

- [ ] **Step 2: Run both — expect FAIL.**
- [ ] **Step 3: Implement.** `sync.ts`:

```ts
import { mathSlice, type ITargetFields } from './state';
import { getSlotModel, getTarget, getTuner } from './restClient';

export function fieldsFromGddData(data: Record<string, unknown>): ITargetFields {
  return {
    rtp: data.rtp == null ? '' : String(data.rtp),
    volatility: data.volatility == null ? '' : String(data.volatility),
    bonusHitRate: data.bonus_hit_rate == null ? '' : String(data.bonus_hit_rate),
  };
}

function isActive(gameId: string): boolean {
  return mathSlice().activeGameId.get() === gameId;
}

export async function refreshTarget(gameId: string): Promise<void> {
  try {
    const t = await getTarget(gameId);
    if (!isActive(gameId)) return;
    const s = mathSlice();
    s.derivedTarget.set(t.target ?? null);
    s.targetGap.set(t.gap ?? null);
  } catch {
    // keep whatever bands we have; transient failures must not blank the strip
  }
}

/** Re-pull doc-derived state (locks, curation params, stored-model result). */
export async function refreshDoc(gameId: string): Promise<void> {
  try {
    const doc = await getSlotModel(gameId);
    if (!isActive(gameId)) return;
    const s = mathSlice();
    s.locks.set(doc.locks);
    s.curationParams.set(doc.params);
    s.verifyResult.set(doc.result);
  } catch {
    // keep current state
  }
}

/** Port of the Tuner pane's issue-#82/PR-#99 re-hydration: refresh the pending
 * tuned model so Apply works for tunes that completed out-of-pane (chat).
 * A streaming run is left untouched. */
export async function refreshTuneResult(gameId: string): Promise<void> {
  const s = mathSlice();
  const gen = s.genStatus.get();
  if (gen === 'tuning' || gen === 'verifying') return;
  try {
    const doc = await getTuner(gameId);
    if (!isActive(gameId)) return;
    s.tuneResult.set(doc.result);
  } catch {
    // keep current state
  }
}
````

`socketClient.ts` — inside `connect()`, after the existing two handlers, add (types from `./state`, `ISlotModelWire` from `./restClient`, helpers from `./sync`):

```ts
sock.on('generate_status', (p: { gameId: string; phase: 'tuning' | 'verifying' | 'done' | 'failed' }) => {
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
  if (p.phase === 'done') void refreshTuneResult(p.gameId);
});
sock.on('tuning_failed', (p: { gameId: string; failure?: string }) => {
  if (!isActive(p.gameId)) return;
  mathSlice().genFailure.set(p.failure ?? 'tune failed');
});
sock.on('curation_progress', (p: { gameId: string; phase: string; done: number | null; total: number | null }) => {
  if (!isActive(p.gameId)) return;
  const s = mathSlice();
  s.verifyStatus.set('running');
  s.verifyProgress.set({ phase: p.phase, done: p.done, total: p.total });
  s.verifyFailure.set(null);
});
sock.on('curation_complete', (p: { gameId: string; doc: ISlotModelWire }) => {
  if (!isActive(p.gameId)) return;
  const s = mathSlice();
  s.verifyResult.set(p.doc.result);
  s.verifyStatus.set(p.doc.result ? p.doc.result.status : 'idle');
  s.verifyProgress.set(null);
  s.locks.set(p.doc.locks);
  s.curationParams.set(p.doc.params);
});
sock.on('curation_failed', (p: { gameId: string; failure?: string }) => {
  if (!isActive(p.gameId)) return;
  const s = mathSlice();
  s.verifyStatus.set('error');
  s.verifyProgress.set(null);
  s.verifyFailure.set(p.failure ?? null);
});
sock.on('slot_model_changed', (p: { gameId: string; updatedAt: string; source: string }) => {
  if (!isActive(p.gameId)) return;
  void refreshDoc(p.gameId); // locks toggled in Game Config, template/agent writes, Apply echo
});
sock.on('gdd_doc_updated', (p: { gameId: string; doc: { aspect: string; data: Record<string, unknown>; updatedAt: string } }) => {
  if (!isActive(p.gameId) || p.doc.aspect !== 'math-model') return;
  const s = mathSlice();
  if (p.doc.updatedAt <= s.gddWatermark.get()) return; // our own echo / stale
  s.gddWatermark.set(p.doc.updatedAt);
  s.targetFields.set(fieldsFromGddData(p.doc.data));
  void refreshTarget(p.gameId);
});
```

Also extend the existing `analytics_progress` handler with one line before the frame reduce: `mathSlice().genProgress.set({ generation: p.generation, maxGenerations: p.maxGenerations });`

- [ ] **Step 4: Run both specs + typecheck — expect PASS.**
- [ ] **Step 5: Commit:** `git commit -m "feat(math): socket wiring for generate, verify, locks and gdd target sync"`

---

### Task 6: actions — hydration, debounced target save, generate/verify/apply

**Files:**

- Modify: `studio/frontend/src/plugins/math/actions.ts`
- Test: `studio/frontend/src/plugins/math/actions.spec.ts`

**Interfaces:**

- Consumes: Tasks 3–5.
- Produces (used by Tasks 7–8): `openGameMath(gameId)` (full hydration), `closeGameMath()`, `editTargetField(key, value)` + `flushTargetSave()` + `TARGET_DEBOUNCE_MS = 600`, `refreshRuns(gameId)`, `generateMath()`, `verifyMath()`, `applyMath()`.

- [ ] **Step 1: Write failing tests** — extend `actions.spec.ts` (its existing pattern: `vi.mock('./restClient')`, `vi.mock('./socketClient')`; add `vi.useFakeTimers()` for debounce):
  - `openGameMath` hydrates locks/curationParams/verifyResult (from `getSlotModel`), tunerParams/tuneResult (`getTuner`), targetFields + gddWatermark (from the `math-model` doc in `getGddDocs`), runs (`fetchRuns`), then target bands (`getTarget`).
  - `editTargetField` sets `targetSaveStatus 'saving'` and only after `TARGET_DEBOUNCE_MS` fires ONE `putMathModelFields` with `{rtp, volatility}` (+ `bonus_hit_rate` only when non-empty); watermark advances to the returned `updatedAt`; status `'saved'`.
  - two rapid edits → one PUT (debounce coalesces).
  - `generateMath` PUTs tuner params first, sets `genStatus 'tuning'`/`applied false`, calls `generate`; a rejected `generate` sets `genStatus 'failed'` + `genFailure`.
  - `verifyMath` PUTs curation params, sets `verifyStatus 'running'`, calls `curate`.
  - `applyMath` calls `applyTuned` and sets `applied true`; failure sets `genFailure 'apply failed'`.
  - `closeGameMath` resets to `makeInitialState()` and leaves the room.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — replace `openGameAnalytics`-era body; keep `selectRun`/`toggleRunSelected`/`scrub` untouched:

```ts
import { mathSlice, makeInitialState, type ITargetFields, type ITuningParams, type ICurationParams } from './state';
import {
  applyTuned,
  curate,
  fetchRuns,
  generate,
  getGddDocs,
  getSlotModel,
  getTuner,
  putCurationParams,
  putMathModelFields,
  putTunerParams,
} from './restClient';
import { mathSock } from './socketClient';
import { fieldsFromGddData, refreshTarget } from './sync';

export function initMath(): void {
  mathSock().connect();
}

export const TARGET_DEBOUNCE_MS = 600;
let targetTimer: ReturnType<typeof setTimeout> | null = null;

export async function openGameMath(gameId: string): Promise<void> {
  const s = mathSlice();
  s.set({ ...makeInitialState(), activeGameId: gameId, loadStatus: 'loading' } as never);
  mathSock().joinMath(gameId);
  try {
    const [doc, tuner, gddDocs, runs] = await Promise.all([getSlotModel(gameId), getTuner(gameId), getGddDocs(gameId), fetchRuns(gameId)]);
    if (s.activeGameId.get() !== gameId) return;
    s.locks.set(doc.locks);
    s.curationParams.set(doc.params);
    s.verifyResult.set(doc.result);
    s.tunerParams.set(tuner.params);
    s.tuneResult.set(tuner.result);
    const mm = gddDocs.find((d) => d.aspect === 'math-model');
    s.targetFields.set(mm ? fieldsFromGddData(mm.data) : { rtp: '', volatility: '', bonusHitRate: '' });
    if (mm) s.gddWatermark.set(mm.updatedAt);
    s.runs.set(runs as never);
    s.selectedRunId.set(runs[0]?.id ?? null);
    s.loadStatus.set('idle');
    await refreshTarget(gameId);
  } catch {
    s.loadStatus.set('error');
  }
}

export function closeGameMath(): void {
  if (targetTimer) {
    clearTimeout(targetTimer);
    targetTimer = null;
  }
  const prev = mathSlice().activeGameId.get();
  if (prev) mathSock().leaveMath(prev);
  mathSlice().set(makeInitialState() as never);
}

/** Re-fetch run history (pane re-open; mirrors the old analytics REST-only refresh). */
export async function refreshRuns(gameId: string): Promise<void> {
  try {
    const runs = await fetchRuns(gameId);
    const s = mathSlice();
    if (s.activeGameId.get() !== gameId) return;
    s.runs.set(runs as never);
    if (!s.selectedRunId.get()) s.selectedRunId.set(runs[0]?.id ?? null);
  } catch {
    // keep current list
  }
}

export function editTargetField(key: keyof ITargetFields, value: string): void {
  const s = mathSlice();
  const cur = (s.targetFields.get({ noproxy: true }) as ITargetFields | null) ?? { rtp: '', volatility: '', bonusHitRate: '' };
  s.targetFields.set({ ...cur, [key]: value });
  s.targetSaveStatus.set('saving');
  if (targetTimer) clearTimeout(targetTimer);
  targetTimer = setTimeout(() => void flushTargetSave(), TARGET_DEBOUNCE_MS);
}

export async function flushTargetSave(): Promise<void> {
  const s = mathSlice();
  const gameId = s.activeGameId.get();
  const fields = s.targetFields.get({ noproxy: true }) as ITargetFields | null;
  if (!gameId || !fields) return;
  const payload: Record<string, unknown> = {};
  if (fields.rtp.trim()) payload.rtp = fields.rtp.trim();
  if (fields.volatility.trim()) payload.volatility = fields.volatility.trim();
  if (fields.bonusHitRate.trim()) payload.bonus_hit_rate = fields.bonusHitRate.trim();
  if (Object.keys(payload).length === 0) return; // nothing to persist yet
  try {
    const doc = await putMathModelFields(gameId, payload);
    if (doc.updatedAt > s.gddWatermark.get()) s.gddWatermark.set(doc.updatedAt);
    s.targetSaveStatus.set('saved');
    await refreshTarget(gameId);
  } catch {
    s.targetSaveStatus.set('error');
  }
}

export async function generateMath(): Promise<void> {
  const s = mathSlice();
  const gameId = s.activeGameId.get();
  if (!gameId) return;
  try {
    const params = s.tunerParams.get({ noproxy: true }) as ITuningParams | null;
    if (params) await putTunerParams(gameId, params);
    s.genStatus.set('tuning');
    s.genFailure.set(null);
    s.genProgress.set(null);
    s.applied.set(false);
    await generate(gameId);
  } catch (e) {
    s.genStatus.set('failed');
    s.genFailure.set(e instanceof Error ? e.message : 'generate failed');
  }
}

export async function verifyMath(): Promise<void> {
  const s = mathSlice();
  const gameId = s.activeGameId.get();
  if (!gameId) return;
  try {
    const params = s.curationParams.get({ noproxy: true }) as ICurationParams | null;
    if (params) await putCurationParams(gameId, params);
    s.verifyStatus.set('running');
    s.verifyFailure.set(null);
    s.verifyProgress.set({ phase: 'starting', done: null, total: null });
    await curate(gameId);
  } catch {
    s.verifyStatus.set('error');
    s.verifyProgress.set(null);
  }
}

export async function applyMath(): Promise<void> {
  const s = mathSlice();
  const gameId = s.activeGameId.get();
  if (!gameId) return;
  try {
    await applyTuned(gameId);
    s.applied.set(true);
  } catch {
    s.genFailure.set('apply failed');
  }
}
```

- [ ] **Step 4: Run — expect PASS**, plus typecheck + full vitest.
- [ ] **Step 5: Commit:** `git commit -m "feat(math): pane actions - hydration, debounced target save, generate/verify/apply"`

---

### Task 7: TargetStrip component

**Files:**

- Create: `studio/frontend/src/plugins/math/components/TargetStrip.tsx`
- Test: `studio/frontend/src/plugins/math/components/TargetStrip.spec.tsx`

**Interfaces:**

- Consumes: Task 3 state, Task 6 `editTargetField`.
- Produces: `<TargetStrip />` (no props — reads the slice). Testids: `target-rtp`, `target-volatility`, `target-bonus-rate`, `target-bands`, `target-gap`, `target-save-status`.

- [ ] **Step 1: Write failing component test** (RTL, mirror an existing component spec's setup for seeding `mathSlice()`; `vi.mock('../actions')`):
  - renders inputs from `targetFields` and calls `editTargetField('rtp', '92')` on change;
  - renders `target-bands` when `derivedTarget` set (contains the rtp band), `target-gap` when `targetGap` set;
  - volatility select offers `low/medium/medium-high/high`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement:**

```tsx
import { mathHooks, type ITargetSpec } from '../state';
import { editTargetField } from '../actions';

const VOLATILITY_OPTIONS = ['low', 'medium', 'medium-high', 'high'] as const;

/** Target intent strip. Edits the GDD math-model doc (the single source of
 * target truth) via the debounced PUT + watermark pattern; derived bands from
 * derive_target render read-only beside the inputs. A `target_gap` is fixed in
 * place by filling in the missing field. Note: the GDD store normalizes "90%"
 * to 0.9 on write, so a re-hydrated rtp renders in decimal form. */
export function TargetStrip() {
  const s = mathHooks.usePluginState();
  const fields = s.targetFields.get();
  const target = s.derivedTarget.get() as ITargetSpec | null;
  const gap = s.targetGap.get();
  const save = s.targetSaveStatus.get();
  if (!fields) return null;
  return (
    <div className="flex-none border-b border-hairline p-2 text-xs text-text-2">
      <div className="flex flex-wrap items-center gap-3">
        <label>
          RTP{' '}
          <input
            data-testid="target-rtp"
            value={fields.rtp}
            placeholder="96%"
            onChange={(e) => editTargetField('rtp', e.target.value)}
            className="ml-1 w-16 bg-canvas px-1 text-text-1"
          />
        </label>
        <label>
          Volatility{' '}
          <select
            data-testid="target-volatility"
            value={fields.volatility}
            onChange={(e) => editTargetField('volatility', e.target.value)}
            className="ml-1 bg-canvas px-1 text-text-1"
          >
            <option value="">—</option>
            {VOLATILITY_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          Bonus rate{' '}
          <input
            data-testid="target-bonus-rate"
            value={fields.bonusHitRate}
            placeholder="1:150"
            onChange={(e) => editTargetField('bonusHitRate', e.target.value)}
            className="ml-1 w-16 bg-canvas px-1 text-text-1"
          />
        </label>
        {save !== 'idle' && (
          <span data-testid="target-save-status" className={save === 'error' ? 'text-danger' : 'text-text-3'}>
            {save === 'saving' ? 'saving…' : save === 'saved' ? 'saved' : 'save failed'}
          </span>
        )}
        {target && (
          <span data-testid="target-bands" className="text-text-3">
            RTP {(target.rtp_target - target.rtp_tolerance).toFixed(3)}–{(target.rtp_target + target.rtp_tolerance).toFixed(3)}
            {' · '}vol {target.volatility_min}–{target.volatility_max >= 1e9 ? '∞' : target.volatility_max}
          </span>
        )}
      </div>
      {gap && (
        <div data-testid="target-gap" className="mt-1 text-danger">
          {gap}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit:** `git commit -m "feat(math): target strip bound to gdd math-model intent"`

---

### Task 8: GenerateBar + ResultStrip + AdvancedSection + MathPane shell

**Files:**

- Create: `studio/frontend/src/plugins/math/components/GenerateBar.tsx` + `GenerateBar.spec.tsx`
- Create: `studio/frontend/src/plugins/math/components/ResultStrip.tsx` + `ResultStrip.spec.tsx`
- Create: `studio/frontend/src/plugins/math/components/AdvancedSection.tsx` + `AdvancedSection.spec.tsx`
- Modify: `studio/frontend/src/plugins/math/MathPane.tsx` + `MathPane.spec.tsx`

**Interfaces:**

- Consumes: Tasks 3–7 (`latestOutcome`, `outcomeVerdict`, `allLocked`, `generateMath`, `verifyMath`, `applyMath`, `refreshTuneResult`, `refreshRuns`, `<TargetStrip />`).
- Produces testids (the e2e contract, Task 11): `generate-button`, `generate-status`, `generate-locked-chip`, `generate-error`, `verify-button`, `verify-progress`, `verify-error`, `result-verdict`, `metric-rtp`, `result-lock-chips`, `apply-button`, `math-applied`, `advanced-toggle`, `advanced-params`, `param-master-seed`, `math-no-game`. Tab/chart testids unchanged (`analytics-tab-*`, `scrubber`, …).

- [ ] **Step 1: Write failing component tests:**
  - **GenerateBar**: disabled while `genStatus==='tuning'`; disabled + `generate-locked-chip` visible when all three locks true; disabled when `targetGap` set; status text shows `tuning gen 3/40` from `genProgress`; `generate-error` renders `genFailure`; `verify-button` disabled while running.
  - **ResultStrip**: verdict badge from `outcomeVerdict` (run with failed verify → `FAIL`); `result-lock-chips` renders `locked: bonus` for a run with `locks:{bonus:true}` and is absent when no section locked; `apply-button` disabled without `tuneResult.tunedModel`, enabled with it, gets warning styling when verdict is fail/error; `math-applied` shows after `applied` true; metrics row shows measured RTP with band text from `derivedTarget`.
  - **AdvancedSection**: collapsed by default (`advanced-params` absent), expands on `advanced-toggle`, `param-master-seed` edit writes `tunerParams.masterSeed` in the slice.
  - **MathPane**: `math-no-game` without a game; with a game renders TargetStrip + GenerateBar + tab bar + ResultStrip + AdvancedSection (existing tab assertions stay).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** `GenerateBar.tsx`:

```tsx
import { mathHooks, type ISectionLocks } from '../state';
import { allLocked } from '../reducers';
import { generateMath, verifyMath } from '../actions';

/** Generate = the sub-project-1 backend pipeline (tune → verify), one accent
 * button. Verify-only = curate the STORED model (the Simulator pane's old
 * role, for after hand-edits in Game Config). */
export function GenerateBar() {
  const s = mathHooks.usePluginState();
  const genStatus = s.genStatus.get();
  const verifyStatus = s.verifyStatus.get();
  const progress = s.genProgress.get();
  const locks = s.locks.get() as ISectionLocks | null;
  const gap = s.targetGap.get();
  const failure = s.genFailure.get();
  const verifyProgress = s.verifyProgress.get();
  const verifyFailure = s.verifyFailure.get();

  const running = genStatus === 'tuning' || genStatus === 'verifying' || verifyStatus === 'running';
  const locked = allLocked(locks);
  const statusText =
    genStatus === 'tuning'
      ? progress
        ? `tuning gen ${progress.generation}/${progress.maxGenerations}`
        : 'tuning…'
      : genStatus === 'verifying'
        ? 'verifying…'
        : genStatus === 'done'
          ? 'done'
          : genStatus === 'failed'
            ? 'failed'
            : '';

  return (
    <div className="flex-none border-b border-hairline p-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          data-testid="generate-button"
          onClick={() => void generateMath()}
          disabled={running || locked || !!gap}
          className="rounded bg-accent px-3 py-1 text-sm text-white disabled:opacity-50"
        >
          Generate
        </button>
        <button
          data-testid="verify-button"
          onClick={() => void verifyMath()}
          disabled={running}
          className="rounded px-3 py-1 text-sm text-text-1 hover:bg-raised-hover disabled:text-text-3"
        >
          {verifyStatus === 'running' ? 'Verifying…' : 'Verify only'}
        </button>
        {statusText && (
          <span data-testid="generate-status" className="text-xs text-text-2">
            {statusText}
          </span>
        )}
        {locked && (
          <span data-testid="generate-locked-chip" className="text-xs text-warning">
            all sections locked — nothing to tune
          </span>
        )}
        {verifyProgress && (
          <span data-testid="verify-progress" className="text-xs text-text-3">
            {verifyProgress.phase}
            {verifyProgress.total ? ` ${verifyProgress.done}/${verifyProgress.total}` : ''}
          </span>
        )}
      </div>
      {failure && (
        <div data-testid="generate-error" className="mt-1 text-xs text-danger">
          {failure}
        </div>
      )}
      {verifyFailure && (
        <div data-testid="verify-error" className="mt-1 text-xs text-danger">
          {verifyFailure}
        </div>
      )}
    </div>
  );
}
```

**Accent-token check:** before committing, grep `studio/frontend/src` for `bg-accent` and mirror the exact primary-button classes an existing pane uses (e.g. game-config or gdd). If the codebase's primary buttons use different token names, use those — the styling guard test is authoritative.

`ResultStrip.tsx`:

```tsx
import { mathHooks, type ICurationResult, type IMathRun, type ITargetSpec } from '../state';
import { latestOutcome, outcomeVerdict } from '../reducers';
import { applyMath } from '../actions';

/** Pinned to the LATEST outcome (newest generate run vs verify-only result) —
 * never the RunSelector's browsed run. Apply stays human-gated and is enabled
 * even on a failed verdict (warning styling), per spec. */
export function ResultStrip() {
  const s = mathHooks.usePluginState();
  const outcome = latestOutcome({
    runs: s.runs.get({ noproxy: true }) as IMathRun[],
    verifyResult: s.verifyResult.get({ noproxy: true }) as ICurationResult | null,
  });
  const target = s.derivedTarget.get() as ITargetSpec | null;
  const tuneResult = s.tuneResult.get();
  const genStatus = s.genStatus.get();
  const applied = s.applied.get();

  const verdict = outcomeVerdict(outcome);
  const badge = verdict === 'pass' ? 'PASS' : verdict === 'near_miss' ? 'NEAR-MISS' : verdict === 'fail' ? 'FAIL' : verdict === 'error' ? 'ERROR' : '—';
  const badgeClass =
    verdict === 'pass' ? 'text-success' : verdict === 'near_miss' ? 'text-warning' : verdict === 'fail' || verdict === 'error' ? 'text-danger' : 'text-text-3';
  const metrics = outcome?.kind === 'run' ? (outcome.run.verify?.metrics ?? outcome.run.metrics) : (outcome?.result.metrics ?? null);
  const runLocks = outcome?.kind === 'run' ? outcome.run.locks : null;
  const lockedSections = runLocks ? (['reels', 'paytable', 'bonus'] as const).filter((k) => runLocks[k]) : [];
  const failedVerdict = verdict === 'fail' || verdict === 'error';

  return (
    <div className="flex-none border-t border-hairline p-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="text-text-2">Verdict</span>
        <span data-testid="result-verdict" className={`text-sm font-semibold ${badgeClass}`}>
          {badge}
        </span>
        {lockedSections.length > 0 && (
          <span data-testid="result-lock-chips" className="text-text-3">
            locked: {lockedSections.join(', ')}
          </span>
        )}
        <button
          data-testid="apply-button"
          onClick={() => void applyMath()}
          disabled={!tuneResult?.tunedModel || genStatus === 'tuning' || genStatus === 'verifying'}
          className={`ml-auto rounded px-3 py-1 text-sm ${
            failedVerdict ? 'border border-warning text-warning' : 'text-text-1 hover:bg-raised-hover'
          } disabled:text-text-3`}
        >
          Apply
        </button>
      </div>
      {metrics && (
        <table className="mt-1 text-text-1">
          <tbody>
            <tr>
              <td className="pr-4 text-text-2">Measured RTP</td>
              <td data-testid="metric-rtp">{metrics.rtp.toFixed(4)}</td>
              <td className="pl-3 text-text-3">
                {target ? `band ${(target.rtp_target - target.rtp_tolerance).toFixed(3)}–${(target.rtp_target + target.rtp_tolerance).toFixed(3)}` : ''}
              </td>
            </tr>
            <tr>
              <td className="pr-4 text-text-2">Volatility</td>
              <td>{metrics.volatility.toFixed(3)}</td>
              <td className="pl-3 text-text-3">
                {target ? `band ${target.volatility_min}–${target.volatility_max >= 1e9 ? '∞' : target.volatility_max}` : ''}
              </td>
            </tr>
            <tr>
              <td className="pr-4 text-text-2">Hit frequency</td>
              <td>{metrics.hitFrequency.toFixed(4)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      )}
      {applied && (
        <p data-testid="math-applied" className="mt-1 text-success">
          Applied — Game Config now reflects the tuned model.
        </p>
      )}
    </div>
  );
}
```

`AdvancedSection.tsx`:

```tsx
import { useState } from 'react';
import { mathHooks } from '../state';

/** GA knobs + curation params (the old Tuner/Simulator settings). Edits land
 * in the slice; they persist to the doc via the PUT that precedes every
 * Generate (tuner_params) / Verify (params) — see actions.ts. */
export function AdvancedSection() {
  const s = mathHooks.usePluginState();
  const [open, setOpen] = useState(false);
  const gp = s.tunerParams.ornull;
  const cp = s.curationParams.ornull;
  return (
    <div className="flex-none border-t border-hairline p-2 text-xs text-text-2">
      <button data-testid="advanced-toggle" onClick={() => setOpen((v) => !v)} className="text-text-2 underline">
        {open ? 'hide advanced' : 'advanced'}
      </button>
      {open && (
        <div data-testid="advanced-params" className="mt-2 flex flex-wrap gap-3">
          {gp && (
            <>
              <label>
                seed{' '}
                <input
                  data-testid="param-master-seed"
                  type="number"
                  value={gp.masterSeed.get()}
                  onChange={(e) => gp.masterSeed.set(Number(e.target.value))}
                  className="w-20 bg-canvas px-1 text-text-1"
                />
              </label>
              <label>
                population{' '}
                <input
                  type="number"
                  value={gp.population.get()}
                  onChange={(e) => gp.population.set(Number(e.target.value))}
                  className="w-16 bg-canvas px-1 text-text-1"
                />
              </label>
              <label>
                generations{' '}
                <input
                  type="number"
                  value={gp.maxGenerations.get()}
                  onChange={(e) => gp.maxGenerations.set(Number(e.target.value))}
                  className="w-16 bg-canvas px-1 text-text-1"
                />
              </label>
              <label>
                search{' '}
                <input
                  type="number"
                  value={gp.searchCandidateCount.get()}
                  onChange={(e) => gp.searchCandidateCount.set(Number(e.target.value))}
                  className="w-24 bg-canvas px-1 text-text-1"
                />
              </label>
              <label>
                final{' '}
                <input
                  type="number"
                  value={gp.finalCandidateCount.get()}
                  onChange={(e) => gp.finalCandidateCount.set(Number(e.target.value))}
                  className="w-24 bg-canvas px-1 text-text-1"
                />
              </label>
              <label>
                mutation{' '}
                <input
                  type="number"
                  step="0.05"
                  value={gp.mutationRate.get()}
                  onChange={(e) => gp.mutationRate.set(Number(e.target.value))}
                  className="w-16 bg-canvas px-1 text-text-1"
                />
              </label>
            </>
          )}
          {cp && (
            <>
              <label>
                pool{' '}
                <input
                  data-testid="param-pool-size"
                  type="number"
                  value={cp.poolSize.get()}
                  onChange={(e) => cp.poolSize.set(Number(e.target.value))}
                  className="w-24 bg-canvas px-1 text-text-1"
                />
              </label>
              <label>
                candidates{' '}
                <input
                  type="number"
                  value={cp.candidateCount.get()}
                  onChange={(e) => cp.candidateCount.set(Number(e.target.value))}
                  className="w-24 bg-canvas px-1 text-text-1"
                />
              </label>
              <label>
                sim seed{' '}
                <input
                  type="number"
                  value={cp.masterSeed.get()}
                  onChange={(e) => cp.masterSeed.set(Number(e.target.value))}
                  className="w-20 bg-canvas px-1 text-text-1"
                />
              </label>
              <label>
                rtp tol{' '}
                <input
                  type="number"
                  step="0.005"
                  value={cp.rtpTolerance.get()}
                  onChange={(e) => cp.rtpTolerance.set(Number(e.target.value))}
                  className="w-16 bg-canvas px-1 text-text-1"
                />
              </label>
              <label>
                corr band{' '}
                <input
                  type="number"
                  step="0.01"
                  value={cp.realizedCorrectionBand.get()}
                  onChange={(e) => cp.realizedCorrectionBand.set(Number(e.target.value))}
                  className="w-16 bg-canvas px-1 text-text-1"
                />
              </label>
              <label>
                bonus tol{' '}
                <input
                  type="number"
                  step="0.05"
                  value={cp.bonusRateTolerance.get()}
                  onChange={(e) => cp.bonusRateTolerance.set(Number(e.target.value))}
                  className="w-16 bg-canvas px-1 text-text-1"
                />
              </label>
            </>
          )}
        </div>
      )}
    </div>
  );
}
```

`MathPane.tsx` — keep the existing tab bar/body EXACTLY as-is (TABS array, tablist markup, tab-content conditions, header run stamp), change the frame around it:

- mount effect (replaces the old `openGameAnalytics` call — a full re-hydrate would clobber a live run):

```tsx
// Pane (re-)open: refresh what a closed pane may have missed — the run history
// and the pending tuned model (issue #82 / PR #99 port). refreshTuneResult
// no-ops while a generate is streaming.
useEffect(() => {
  if (activeGameId) {
    void refreshRuns(activeGameId);
    void refreshTuneResult(activeGameId);
  }
}, [activeGameId]);
```

- no-game branch: testid `math-no-game`, copy "Open a game to tune its math toward the GDD intent."
- returned layout:

```tsx
return (
  <div className="flex h-full flex-col bg-surface">
    <div className="flex flex-none items-center justify-between border-b border-hairline p-2">
      <span className="text-sm text-text-1">Math</span>
      {run && (
        <span className="text-xs text-text-3">
          {run.verdict === 'pass' ? 'PASS' : run.verdict === 'near_miss' ? 'NEAR-MISS' : ''} · {new Date(run.createdAt).toLocaleString()}
        </span>
      )}
    </div>
    <TargetStrip />
    <GenerateBar />
    {/* existing tablist + tab body markup, unchanged, with the body div keeping min-h-0 flex-1 */}
    <ResultStrip />
    <AdvancedSection />
  </div>
);
```

Imports: `TargetStrip`, `GenerateBar`, `ResultStrip`, `AdvancedSection` from `./components/...`, `refreshRuns` from `./actions`, `refreshTuneResult` from `./sync`.

- [ ] **Step 4: Run all four component specs + MathPane.spec + typecheck + full vitest — expect PASS.**
- [ ] **Step 5: Commit:** `git commit -m "feat(math): unified Math pane - generate bar, result strip, advanced params"`

---

### Task 9: Delete the simulator and tuner plugins

**Files:**

- Delete: `studio/frontend/src/plugins/simulator/` (whole dir), `studio/frontend/src/plugins/tuner/` (whole dir)
- Modify: `studio/frontend/src/plugins/index.ts`, `studio/frontend/src/app/routes/RoomRoute.tsx`, `studio/frontend/src/app/routes/RoomRoute.spec.tsx`

**Interfaces:**

- Consumes: nothing new. After this task the View menu lists Math but not Simulator/Tuner (menu derives from `PLUGINS` automatically).

- [ ] **Step 1:** `git rm -r studio/frontend/src/plugins/simulator studio/frontend/src/plugins/tuner`
- [ ] **Step 2:** Remove their imports + entries from `plugins/index.ts` (`simulator`, `tuner`). In `RoomRoute.tsx` remove the `openGameSim/closeGameSim` and `openGameTuner/closeGameTuner` import lines and call sites (lines ~9-10, 38-39, 60-61). In `RoomRoute.spec.tsx` remove the matching mocks/assertions.
- [ ] **Step 3:** `npx nx run frontend:typecheck` — chase any remaining import of the deleted dirs (there should be none; the only cross-plugin reference was SimulatorPane→game-config, which died with the file).
- [ ] **Step 4:** Full gates: prettier --check, typecheck, `npx nx run frontend:test`, build — all green.
- [ ] **Step 5: Commit:** `git commit -m "feat(math)!: delete simulator and tuner panes (replaced by Math pane)"`

---

### Task 10: Backend prune — dead routes, sockets, emissions

Everything here lost its last consumer in Task 9. Verified consumers beforehand: agent tools call the hub/store directly (never these routes); `game-config` still joins via `join_sim` (KEEP `join_sim`/`leave_sim` + `attach_sim_subscriber`); the math pane consumes `tuning_failed` (KEEP).

**Files:**

- Modify: `studio/backend/app/math/rest.py` (delete `POST /games/{id}/tuner/tune` ~line 115, `GET /games/{id}/tuner/seed` ~line 96)
- Modify: `studio/backend/app/math/sockets.py` (delete `join_tuner`/`leave_tuner`)
- Modify: `studio/backend/app/math/hub.py` (delete `attach_tuner_subscriber`; simplify `request_tune`)
- Test: `studio/backend/tests/test_math_rest.py`, `test_math_sockets.py`, `test_math_hub.py`, `test_math_wiring.py`

**Interfaces:**

- Produces: `request_tune(game_id) -> TuneResult | None` — no `record` kwarg (recording is the generate pipeline's job); emits `tuning_failed` on gap/error and NOTHING on success (`run_complete` covers it); `tuning_progress`/`tuning_complete` emissions removed.

- [ ] **Step 1: Update the tests first (RED):**
  - `test_math_wiring.py:18` — remove `"/games/{game_id}/tuner/tune"` (and seed if listed) from the expected-routes list.
  - `test_math_sockets.py` — remove the `join_tuner` handler test (~line 54) and drop `"join_tuner", "leave_tuner"` from the registered-handlers assertion (~line 76).
  - `test_math_hub.py:153-154` — the tune test asserted `tuning_progress`/`tuning_complete` in emitted names; invert: assert both are NOT emitted, and that a successful `request_tune` emits nothing terminal (the pipeline's `run_complete` is asserted in test_math_generate). Keep/adjust the `tuning_failed` gap-path assertions.
  - `test_math_rest.py` — delete the seed/tune route tests.
  - Grep to confirm nothing else references the deleted surface: `rg "tuner/tune|tuner/seed|join_tuner|tuning_complete|tuning_progress|attach_tuner" studio/backend` — only the files above should hit.
- [ ] **Step 2: Run — expect FAIL** (routes/handlers still exist): `uv --directory studio/backend run pytest tests/test_math_wiring.py tests/test_math_sockets.py tests/test_math_hub.py tests/test_math_rest.py -q`
- [ ] **Step 3: Implement:** delete the two routes; delete the two socket handlers; delete `attach_tuner_subscriber`; in `request_tune` remove the `record` kwarg + `started`/`duration_ms` bookkeeping + the `record_run` call + the `tuning_progress` emit inside `on_progress` (keep the `analytics_progress` emit) + the success-path `tuning_complete` emit — the failure path becomes:

```python
        if result.status not in ("pass", "near_miss"):
            await self._sio.emit("tuning_failed",
                                 {"gameId": game_id,
                                  "failure": result.failure or "tune failed"},
                                 room=game_id)
```

(The gap path already emits `{gameId, failure}`; this unifies the error path on the same shape — the math pane's `tuning_failed` handler reads `p.failure`.)

(keep `save_tune_result` — Apply and re-hydration read `doc.tune_result`). Update `_generate_reserved`'s call site: `result = await self.request_tune(game_id)`. The agent tool path (`math_hub.generate`) is unchanged.

- [ ] **Step 4: Run the FULL backend suite — expect PASS:** `uv --directory studio/backend run pytest -q`
- [ ] **Step 5: Commit:** `git commit -m "refactor(math)!: prune pane-only tune/seed routes and dead tuner socket surface"`

---

### Task 11: E2e — new `math-plugin.spec.ts`, rework tuner-chat + game-config, delete old specs

Playwright is the behavioral contract; assert observable end-state, never dispatch.

**Files:**

- Create: `studio/frontend/e2e/math-plugin.spec.ts`
- Modify: `studio/frontend/e2e/tuner-chat.spec.ts`, `studio/frontend/e2e/game-config.spec.ts`
- Delete: `studio/frontend/e2e/simulator.spec.ts`, `tuner.spec.ts`, `math-analytics-evolution.spec.ts`, `math-analytics-profile.spec.ts`, `math-analytics-compare-report.spec.ts`

**Interfaces:**

- Consumes: Task 8 testids; pane menu item `view-open-math/viewer`.

- [ ] **Step 1: Lift the shared constants BEFORE deleting.** Copy verbatim from the merged source (mirror source, not this plan): `DETUNED` model + `FAST_TUNER_PARAMS` + `FAST_SIM_PARAMS` + the `setupGame` helper shape from `tuner.spec.ts` (lines ~10-80), and `MODEL_09` from `simulator.spec.ts`, into the new `math-plugin.spec.ts`. Then `git rm` the five old spec files.
- [ ] **Step 2: Write `math-plugin.spec.ts`** with a local opener and four tests:

```ts
async function openMath(page: Page) {
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-math/viewer').click();
  await expect(page.getByTestId('generate-button')).toBeVisible();
}
```

**Test 1 — the full contract: edit target in the pane → Generate → live frames → verdict → Apply → Game Config reflects.** Seed room + DETUNED model + FAST tuner/sim params via REST but NO gdd intent. `test.setTimeout(300_000)` (real GA). Flow:

1. open room, `openMath(page)`;
2. `target-gap` visible (missing intent surfaces in place);
3. fill `target-rtp` = `90%`, select `target-volatility` = `low`; expect `target-gap` hidden and `target-bands` visible (debounced PUT + derive_target round-trip);
4. click `analytics-tab-evolution`, then `generate-button`;
5. `generate-status` shows `tuning gen` (live), then `scrubber` becomes visible (streamed frames), then `generate-status` = `done` (120s timeout);
6. `result-verdict` = `PASS` (independent verify of the winner); `metric-rtp` parses within `0.9 ± rtpTolerance`;
7. click `apply-button`, expect `math-applied` visible;
8. REST `GET /games/{id}/slot-model` → `sym2.payout > 1` (persisted end-state, same assertion tuner.spec used);
9. open Game Config via View menu, expect `gc-sync-pill` to contain `tuner` (external-write flash) OR `gc-stat-window` reflecting the model — use the pill (`game-config.spec.ts:135` precedent).

**Test 2 — out-of-pane run re-hydrates the pane; run carries lock chips.** Seed like Test 1 but WITH gdd intent via REST (`{fields: {rtp: '90%', volatility: 'low'}}`), plus `PUT /slot-model` with `locks: {reels: false, paytable: false, bonus: true}`. `POST /games/{id}/math/generate` via `request`; poll `GET /analytics/runs?game_id=…` until a run appears (mirror tuner.spec's old poll loop, 120s). Then open the pane and assert: `result-verdict` PASS, `result-lock-chips` contains `bonus`, `apply-button` enabled — Apply works for runs the pane never watched (PR #99 contract).

**Test 3 — Verify only (the Simulator pane's old role).** Seed `MODEL_09` + intent `rtp 90% / low` + FAST sim params via REST. Open pane, click `verify-button`, expect `result-verdict` PASS and `metric-rtp` within band (mirrors old simulator.spec PASS test; the FAIL variant is covered by ResultStrip vitest).

**Test 4 — all-locked disables Generate.** Seed intent + `locks: {reels: true, paytable: true, bonus: true}` via REST. Open pane: `generate-button` disabled, `generate-locked-chip` visible. Cheap (no GA run).

No new cassettes: the GA binary is masterSeed-deterministic and the GDD PUTs are direct REST (no LLM).

- [ ] **Step 3: Rework `tuner-chat.spec.ts`** — replace the pane-assert block (lines ~156-159):

```ts
await page.getByTestId('menu-view').click();
await expect(page.getByTestId('view-open-math/viewer')).toBeVisible({ timeout: 5_000 });
await page.getByTestId('view-open-math/viewer').click();
await expect(page.getByTestId('result-verdict')).toContainText('PASS', { timeout: 10_000 });
```

Update the section comment (the verdict now hydrates from the persisted run/tune result on pane open — re-hydration port). Cassettes unchanged.

- [ ] **Step 4: Rework `game-config.spec.ts`** — delete the obsolete test `'simulator pane has no textarea and links to Game Config'` (lines ~151-159; its subject pane no longer exists and its purpose — model editing lives in Game Config — is now structural).
- [ ] **Step 5: Run the FULL e2e suite** (replay tier, worktree ports). PowerShell:

```powershell
# window 1 — replay backend on :8001 (leave running)
cd C:\code\bloom.wt\math-plugin\studio\backend
$env:PROVIDER_MODE='replay'; $env:MONGO_DB='bloom_studio_wt1'; $env:MEDIA_DIR='var/media_wt1'
uv run uvicorn app.main:app --port 8001

# window 2 — the suite (offset MUST be set or Playwright attaches to another session's :4200 stack)
cd C:\code\bloom.wt\math-plugin
$env:BLOOM_PORT_OFFSET='1'
npx playwright test --config=studio/frontend/playwright.config.ts
```

First tune triggers a release cargo build of `bloom-tuner` — slow once, then cached. Expected: full suite green (was 86 + new spec − deleted specs).

- [ ] **Step 6: Commit:** `git commit -m "test(math): math-plugin e2e contract; rework tuner-chat/game-config; drop replaced specs"`

---

### Task 12: Final gates, docs sweep, PR

- [ ] **Step 1:** `rg -i "simulator pane|tuner pane|math analytics|math-analytics" docs studio/frontend/src studio/backend README.md` — update stale pane references in docs the diff touches (do NOT rewrite unrelated docs; a one-line fix where a doc names a deleted pane is enough).
- [ ] **Step 2:** Full verification, in order:
  - `uv --directory studio/backend run pytest -q` — green
  - `node_modules/.bin/prettier --check .` — clean (use the PINNED prettier, never npx)
  - `npx nx run frontend:typecheck && npx nx run frontend:test && npx nx run frontend:build` — green
  - Full e2e (Task 11 Step 5 procedure) if any code changed since that run.
- [ ] **Step 3:** Push + PR (never present a merge-options menu):

```powershell
git push -u origin feat/math-plugin
gh pr create --title "feat(math): unified Math plugin (SP3) - replaces simulator/tuner/analytics panes" --body "..."
```

PR body: what shipped (pane layout, re-hydration port, locks-on-runs, prune list), spec link, e2e evidence (suite counts), and the note that `/tuner/tune`, `/tuner/seed`, `join_tuner`, `tuning_progress/complete` were removed with their last consumers.

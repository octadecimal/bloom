# Math Verdict In-Flight State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While a tune or verify is in flight, the Math pane's Verdict strip shows a neutral RUNNING…/CANCELLING… badge and hides the previous run's verdict/metrics, instead of presenting the stale result as current.

**Architecture:** Pure view change in `ResultStrip.tsx` — it already subscribes to the math plugin's hookstate slice, so it derives a `running` flag from `genStatus`/`verifyStatus` and gates the badge, metrics table, stop-reason, lock chips, and "Applied" note on it. No state-shape, reducer, or backend changes. Spec: `docs/superpowers/specs/2026-07-05-math-verdict-inflight-design.md`.

**Tech Stack:** React + hookstate, Vitest + Testing Library (unit), Playwright (e2e, replay backend).

## Global Constraints

- Work in worktree `C:\code\bloom.wt\math-verdict-inflight`, branch `fix/math-verdict-inflight`. Never touch the primary checkout (`C:\code\bloom`).
- This worktree's `BLOOM_PORT_OFFSET` is `1` (already in its `.env`): backend `:8001`, studio frontend `:4201`, runtime `:4301`, Mongo DB `bloom_studio_wt1`. **Always export `BLOOM_PORT_OFFSET=1` before Playwright or backend commands** — otherwise Playwright's `reuseExistingServer` silently attaches to another session's default-port stack.
- Semantic commits (`fix(math): …`, `test(math): …`).
- Badge copy, exact: `RUNNING…` and `CANCELLING…` (horizontal-ellipsis character `…`, matching GenerateBar's `tuning…`).
- Formatting gate uses the **pinned** prettier (`node_modules\.bin\prettier`), never `npx prettier`.
- `just` recipes fail on this machine ("could not find the shell `sh`") — every step below spells out the underlying command instead.

---

### Task 1: ResultStrip in-flight state (unit TDD)

**Files:**

- Modify: `studio/frontend/src/plugins/math/components/ResultStrip.tsx`
- Test: `studio/frontend/src/plugins/math/components/ResultStrip.spec.tsx`

**Interfaces:**

- Consumes: `IMathState.genStatus` (`'idle' | 'tuning' | 'verifying' | 'done' | 'failed' | 'cancelling' | 'cancelled'`) and `IMathState.verifyStatus` (`'idle' | 'running' | 'pass' | 'fail' | 'error'`) from `../state` — both already exist; `latestOutcome`/`outcomeVerdict` from `../reducers` — unchanged.
- Produces: `data-testid="result-verdict"` renders `RUNNING…` while `genStatus ∈ {tuning, verifying}` or `verifyStatus === 'running'`, and `CANCELLING…` while `genStatus === 'cancelling'`; while any of those hold, `metric-rtp`, `result-stop-reason`, `result-lock-chips`, and `math-applied` are absent from the DOM and `apply-button` is disabled. Task 2's e2e assertions rely on exactly this.

- [ ] **Step 1: Bootstrap the worktree's frontend deps** (fresh worktree has no `node_modules`)

Run (PowerShell, from `C:\code\bloom.wt\math-verdict-inflight`):

```powershell
npm install
```

Expected: completes without error; `node_modules\.bin\prettier` now exists.

- [ ] **Step 2: Write the failing tests**

In `studio/frontend/src/plugins/math/components/ResultStrip.spec.tsx`, first extend the state import with the `ITuneResult` type (an unannotated helper would widen `status: 'pass'` to `string` and fail typecheck):

```tsx
import { MATH_PLUGIN_ID, makeInitialState, mathSlice, type IMathRun, type ITuneResult } from '../state';
```

Then append this `describe` block at the end of the top-level `describe('ResultStrip', …)` (it reuses the file's existing `baseRun` helper and `mathSlice` setup):

```tsx
describe('in-flight state', () => {
  // A previous result rich enough that every hideable element would render.
  const staleRun = () =>
    baseRun({
      stopReason: 'feasible',
      locks: { reels: false, paytable: false, bonus: true },
    });
  const tunedResult = (): ITuneResult => ({ status: 'pass', verdict: 'pass', tunedModel: { reels: [] }, metrics: null, missed: [], failure: null, ranAt: 't' });

  it('shows RUNNING… and hides the previous result while genStatus is tuning', () => {
    mathSlice().runs.set([staleRun()]);
    mathSlice().applied.set(true);
    mathSlice().genStatus.set('tuning');
    render(<ResultStrip />);
    expect(screen.getByTestId('result-verdict').textContent).toBe('RUNNING…');
    expect(screen.queryByTestId('metric-rtp')).toBeNull();
    expect(screen.queryByTestId('result-stop-reason')).toBeNull();
    expect(screen.queryByTestId('result-lock-chips')).toBeNull();
    expect(screen.queryByTestId('math-applied')).toBeNull();
  });

  it('shows RUNNING… while genStatus is verifying', () => {
    mathSlice().runs.set([staleRun()]);
    mathSlice().genStatus.set('verifying');
    render(<ResultStrip />);
    expect(screen.getByTestId('result-verdict').textContent).toBe('RUNNING…');
  });

  it('shows CANCELLING… while genStatus is cancelling', () => {
    mathSlice().runs.set([staleRun()]);
    mathSlice().genStatus.set('cancelling');
    render(<ResultStrip />);
    expect(screen.getByTestId('result-verdict').textContent).toBe('CANCELLING…');
    expect(screen.queryByTestId('metric-rtp')).toBeNull();
  });

  it('shows RUNNING… while a verify-only curation is in flight', () => {
    mathSlice().runs.set([staleRun()]);
    mathSlice().verifyStatus.set('running');
    render(<ResultStrip />);
    expect(screen.getByTestId('result-verdict').textContent).toBe('RUNNING…');
    expect(screen.queryByTestId('metric-rtp')).toBeNull();
  });

  it('disables Apply during a verify-only run, even with a tuned model', () => {
    mathSlice().tuneResult.set(tunedResult());
    mathSlice().verifyStatus.set('running');
    render(<ResultStrip />);
    expect((screen.getByTestId('apply-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables Apply while cancelling, even with a tuned model', () => {
    mathSlice().tuneResult.set(tunedResult());
    mathSlice().genStatus.set('cancelling');
    render(<ResultStrip />);
    expect((screen.getByTestId('apply-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('reverts to the latest outcome once the run is done', () => {
    mathSlice().runs.set([staleRun()]);
    mathSlice().genStatus.set('done');
    render(<ResultStrip />);
    expect(screen.getByTestId('result-verdict').textContent).toBe('PASS');
    expect(screen.getByTestId('metric-rtp')).toBeTruthy();
    expect(screen.getByTestId('result-stop-reason')).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run (PowerShell, from `C:\code\bloom.wt\math-verdict-inflight\studio\frontend`):

```powershell
npx vitest run src/plugins/math/components/ResultStrip.spec.tsx
```

Expected: the 7 new `in-flight state` tests FAIL (badge shows `PASS`/`—` instead of `RUNNING…`, hidden elements still present); all pre-existing tests still PASS.

- [ ] **Step 4: Implement the in-flight gate in ResultStrip**

Replace the full contents of `studio/frontend/src/plugins/math/components/ResultStrip.tsx` with:

```tsx
import { mathHooks, type ICurationResult, type IMathRun, type ITargetSpec } from '../state';
import { latestOutcome, outcomeVerdict } from '../reducers';
import { applyMath } from '../actions';

/** Pinned to the LATEST outcome (newest generate run vs verify-only result) —
 * never the RunSelector's browsed run. Apply stays human-gated and is enabled
 * even on a failed verdict (warning styling), per spec. While a tune / verify /
 * cancel is in flight the strip shows a neutral RUNNING…/CANCELLING… badge and
 * hides the previous outcome entirely (spec:
 * docs/superpowers/specs/2026-07-05-math-verdict-inflight-design.md). */
export function ResultStrip() {
  const s = mathHooks.usePluginState();
  const outcome = latestOutcome({
    runs: s.runs.get({ noproxy: true }) as IMathRun[],
    verifyResult: s.verifyResult.get({ noproxy: true }) as ICurationResult | null,
  });
  const target = s.derivedTarget.get() as ITargetSpec | null;
  const tuneResult = s.tuneResult.get();
  const genStatus = s.genStatus.get();
  const verifyStatus = s.verifyStatus.get();
  const applied = s.applied.get();

  const running = genStatus === 'tuning' || genStatus === 'verifying' || genStatus === 'cancelling' || verifyStatus === 'running';

  const verdict = outcomeVerdict(outcome);
  const badge = running
    ? genStatus === 'cancelling'
      ? 'CANCELLING…'
      : 'RUNNING…'
    : verdict === 'pass'
      ? 'PASS'
      : verdict === 'near_miss'
        ? 'NEAR-MISS'
        : verdict === 'fail'
          ? 'FAIL'
          : verdict === 'error'
            ? 'ERROR'
            : '—';
  const badgeClass = running
    ? 'text-text-2'
    : verdict === 'pass'
      ? 'text-success'
      : verdict === 'near_miss'
        ? 'text-warning'
        : verdict === 'fail' || verdict === 'error'
          ? 'text-danger'
          : 'text-text-3';
  const metrics = outcome?.kind === 'run' ? (outcome.run.verify?.metrics ?? outcome.run.metrics) : (outcome?.result.metrics ?? null);
  const runLocks = outcome?.kind === 'run' ? outcome.run.locks : null;
  const lockedSections = runLocks ? (['reels', 'paytable', 'bonus'] as const).filter((k) => runLocks[k]) : [];
  const failedVerdict = !running && (verdict === 'fail' || verdict === 'error');

  const stopReason = outcome?.kind === 'run' ? outcome.run.stopReason : null;
  const generations = outcome?.kind === 'run' ? outcome.run.trace.length : 0;
  const stopLabel =
    stopReason === 'feasible'
      ? `target reached in ${generations} generation${generations === 1 ? '' : 's'}`
      : stopReason === 'stagnated'
        ? `stagnated after ${generations} generations`
        : stopReason === 'budget'
          ? `generation budget exhausted (${generations})`
          : null;

  return (
    <div className="flex-none border-t border-hairline p-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="text-text-2">Verdict</span>
        <span data-testid="result-verdict" className={`text-sm font-semibold ${badgeClass}`}>
          {badge}
        </span>
        {!running && stopLabel && (
          <span data-testid="result-stop-reason" className="text-text-3">
            {stopLabel}
          </span>
        )}
        {!running && lockedSections.length > 0 && (
          <span data-testid="result-lock-chips" className="text-text-3">
            locked: {lockedSections.join(', ')}
          </span>
        )}
        <button
          data-testid="apply-button"
          onClick={() => void applyMath()}
          disabled={!tuneResult?.tunedModel || running}
          className={`ml-auto rounded px-3 py-1 text-sm ${
            failedVerdict ? 'border border-warning text-warning' : 'text-text-1 hover:bg-raised-hover'
          } disabled:text-text-3`}
        >
          Apply
        </button>
      </div>
      {!running && metrics && (
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
      {!running && applied && (
        <p data-testid="math-applied" className="mt-1 text-success">
          Applied — Game Config now reflects the tuned model.
        </p>
      )}
    </div>
  );
}
```

The diff vs today's file, for orientation: read `verifyStatus`; add `running`; badge/badgeClass get a `running` branch; Apply's `disabled` becomes `!tuneResult?.tunedModel || running` (previously missed `cancelling` and verify-only-running); `failedVerdict` gains `!running` so Apply doesn't wear stale warning styling mid-run; the four outcome renders (`stopLabel`, lock chips, metrics table, applied note) gain `!running &&`.

- [ ] **Step 5: Run the spec file to verify all tests pass**

Run (from `studio\frontend`):

```powershell
npx vitest run src/plugins/math/components/ResultStrip.spec.tsx
```

Expected: PASS — all tests green (14 pre-existing + 7 new).

- [ ] **Step 6: Run the full frontend unit suite** (guards MathPane/e2e-adjacent specs that render ResultStrip)

Run (from `studio\frontend`):

```powershell
npx vitest run
```

Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

Run (from the worktree root):

```powershell
git add studio/frontend/src/plugins/math/components/ResultStrip.tsx studio/frontend/src/plugins/math/components/ResultStrip.spec.tsx
git commit -m "fix(math): show RUNNING badge, hide stale verdict while a run is in flight"
```

---

### Task 2: E2e mid-run assertions + gates

**Files:**

- Modify: `studio/frontend/e2e/math-plugin.spec.ts` (test 1 "full contract" ~line 174; test 5 "cancel" ~line 308)

**Interfaces:**

- Consumes: Task 1's rendered contract — `result-verdict` reads `RUNNING…` while a run is in flight, `apply-button` disabled, `metric-rtp` absent.
- Produces: nothing downstream — this closes out the branch's behavioral contract in the authoritative Playwright suite.

- [ ] **Step 1: Add the mid-run assertion to test 1 (generate flow)**

In `studio/frontend/e2e/math-plugin.spec.ts`, directly after the existing `tuning gen` poll (the `await expect.poll(…).toContain('tuning gen')` line, ~line 183), add:

```ts
// In-flight verdict: the strip must not present the previous result as
// current while the pipeline runs. Same deterministic multi-generation
// window as the poll above; RUNNING… spans tune AND verify phases, so this
// is wider than the 'tuning gen' text itself.
await expect(page.getByTestId('result-verdict')).toContainText('RUNNING');
await expect(page.getByTestId('metric-rtp')).toBeHidden();
```

Note: placed _after_ the `tuning gen` poll on purpose — the run is then provably still in flight for several generations, so a plain assert (no poll) is race-free. Do NOT place it before the poll.

- [ ] **Step 2: Add the mid-run assertions to test 5 (cancel flow)**

In the same file, in the cancel test, directly after `await expect(page.getByTestId('generate-status')).toContainText('tuning', { timeout: 15_000 });` (~line 309), add:

```ts
// >60s deterministic window (SLOW_TUNER_PARAMS) — plain asserts are safe.
await expect(page.getByTestId('result-verdict')).toContainText('RUNNING');
await expect(page.getByTestId('apply-button')).toBeDisabled();
```

Then, after the existing `await expect(page.getByTestId('generate-button')).toBeEnabled();` post-cancel line (~line 314), add:

```ts
// Post-cancel the strip reverts to latestOutcome — nothing persisted here,
// so the badge is the no-outcome dash again, not a stuck RUNNING…
await expect(page.getByTestId('result-verdict')).toHaveText('—');
```

Do NOT assert `CANCELLING…` in e2e — the cancelling→cancelled window is not deterministic in replay (spec: no flaky assertions; the Task 1 unit test carries that state).

- [ ] **Step 3: Start the replay backend on this worktree's ports**

Prereq: native `mongod` on `:27017` must be running (it's a machine service; check with `Get-Process mongod`). Backend deps: if `studio/backend/.venv` is missing, first run `cd studio\backend; uv sync`.

Run in the background (PowerShell, from the worktree root — this is `just backend-serve-replay` spelled out for offset 1):

```powershell
cd studio\backend
$env:PROVIDER_MODE = 'replay'; $env:MONGO_DB = 'bloom_studio_wt1'; $env:MEDIA_DIR = 'var/media_wt1'
uv run uvicorn app.main:app --port 8001
```

Verify: `Invoke-RestMethod http://localhost:8001/health` reports `providerMode: replay`.

- [ ] **Step 4: Run the math-plugin e2e spec** (fast signal before the full suite)

Run (PowerShell, from the worktree root):

```powershell
$env:BLOOM_PORT_OFFSET = '1'
npx playwright test --config=studio/frontend/playwright.config.ts math-plugin
```

Expected: all math-plugin tests PASS, including the new mid-run assertions. If the test-1 `RUNNING` assert ever flakes here, the run window closed too fast — per spec, delete the test-1 assertion rather than shipping a flaky one (test 5's >60s window is the durable e2e anchor).

- [ ] **Step 5: Run the full e2e suite** (repo rule before any PR)

Run (same shell, `BLOOM_PORT_OFFSET` still `1`):

```powershell
npx playwright test --config=studio/frontend/playwright.config.ts
```

Expected: full suite green (~86 tests).

- [ ] **Step 6: Run the CI-equivalent frontend gates** (vitest green ≠ types valid)

Run (PowerShell, from the worktree root):

```powershell
& node_modules\.bin\prettier --check .
npx nx run-many -t typecheck test build
```

Expected: prettier clean; typecheck, test, and build all green.

- [ ] **Step 7: Commit**

```powershell
git add studio/frontend/e2e/math-plugin.spec.ts
git commit -m "test(math): e2e-assert in-flight RUNNING verdict in generate and cancel flows"
```

---

## Done

Both tasks committed on `fix/math-verdict-inflight`. Push and open a PR (`git push -u origin fix/math-verdict-inflight`, then `gh pr create`) per the repo's finishing flow.

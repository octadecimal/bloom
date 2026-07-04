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
          className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
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

import type { IDockviewPanelProps } from 'dockview-react';
import { simulatorHooks, simulatorSlice } from './state';
import { putSlotModel, curate } from './restClient';

export function SimulatorPane(_props: IDockviewPanelProps) {
  const s = simulatorHooks.usePluginState();
  const activeGameId = s.activeGameId.get();

  if (!activeGameId) {
    return (
      <div data-testid="simulator-no-game" className="flex h-full items-center justify-center bg-surface text-text-2">
        Open a game to author and curate its slot model.
      </div>
    );
  }

  const status = s.status.get();
  const result = s.result.get();
  const progress = s.progress.get();
  const modelText = s.modelText.get();

  async function onCurate() {
    try {
      const parsed = JSON.parse(simulatorSlice().modelText.get());
      await putSlotModel(activeGameId!, { model: parsed });
      simulatorSlice().status.set('running');
      simulatorSlice().progress.set({ phase: 'starting', done: null, total: null });
      await curate(activeGameId!);
    } catch (_e) {
      simulatorSlice().status.set('error');
      simulatorSlice().progress.set(null);
    }
  }

  const badge = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : status === 'error' ? 'ERROR' : '';
  const badgeClass = status === 'pass' ? 'text-success' : status === 'fail' || status === 'error' ? 'text-danger' : 'text-text-3';

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex items-center justify-between border-b border-hairline p-2">
        <span className="text-sm text-text-1">Slot model</span>
        <button
          data-testid="curate-button"
          onClick={onCurate}
          disabled={status === 'running'}
          className="rounded px-3 py-1 text-sm text-text-1 hover:bg-raised-hover disabled:text-text-3"
        >
          {status === 'running' ? 'Curating…' : 'Curate'}
        </button>
      </div>

      <textarea
        data-testid="simulator-model-json"
        value={modelText}
        onChange={(e) => simulatorSlice().modelText.set(e.target.value)}
        spellCheck={false}
        className="h-48 flex-none resize-none bg-canvas p-2 font-mono text-xs text-text-1 outline-none"
      />

      {progress && (
        <div data-testid="curation-progress" className="border-t border-hairline p-2 text-xs text-text-2">
          {progress.phase}
          {progress.total ? ` ${progress.done}/${progress.total}` : ''}
        </div>
      )}

      <div className="flex-1 overflow-auto p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-sm text-text-2">Verdict</span>
          <span data-testid="curation-status" className={`text-sm font-semibold ${badgeClass}`}>
            {badge}
          </span>
        </div>
        {result && (
          <table className="text-xs text-text-1">
            <tbody>
              <tr>
                <td className="pr-4 text-text-2">Measured RTP</td>
                <td data-testid="metric-rtp">{result.metrics.rtp.toFixed(4)}</td>
              </tr>
              <tr>
                <td className="pr-4 text-text-2">Realized RTP</td>
                <td>{result.realizedRtp?.toFixed(4) ?? '—'}</td>
              </tr>
              <tr>
                <td className="pr-4 text-text-2">Volatility</td>
                <td>{result.metrics.volatility.toFixed(3)}</td>
              </tr>
              <tr>
                <td className="pr-4 text-text-2">Hit frequency</td>
                <td>{result.metrics.hitFrequency.toFixed(4)}</td>
              </tr>
              <tr>
                <td className="pr-4 text-text-2">Pool size</td>
                <td>{result.poolSize ?? '—'}</td>
              </tr>
            </tbody>
          </table>
        )}
        {result?.failure && <p className="mt-2 text-xs text-danger">{result.failure}</p>}
      </div>
    </div>
  );
}

import { useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { tunerHooks, tunerSlice } from './state';
import { tune, applyTuner, putTuner } from './restClient';
import { refreshSeedAndTarget } from './actions';

export function TunerPane(_props: IDockviewPanelProps) {
  const s = tunerHooks.usePluginState();
  const activeGameId = s.activeGameId.get();
  const [showAdvanced, setShowAdvanced] = useState(false);

  if (!activeGameId) {
    return (
      <div data-testid="tuner-no-game" className="flex h-full items-center justify-center bg-surface text-text-2">
        Open a game to tune its slot model toward the GDD intent.
      </div>
    );
  }

  const status = s.status.get();
  const result = s.result.get();
  const failure = s.failure.get();
  const progress = s.progress.get();
  const params = s.params.get();
  const targetGap = s.targetGap.get();
  const applied = s.applied.get();
  const hasTunedModel = !!result?.tunedModel;

  async function onTune() {
    try {
      const p = tunerSlice().params.get();
      if (p) await putTuner(activeGameId!, p as never);
      tunerSlice().applied.set(false);
      tunerSlice().status.set('running');
      tunerSlice().progress.set({ generation: 0, maxGenerations: p?.maxGenerations ?? 0, bestFitness: 0, bestRtp: 0, bestVolatility: 0 });
      await tune(activeGameId!);
    } catch (_e) {
      tunerSlice().status.set('error');
      tunerSlice().progress.set(null);
    }
  }

  async function onApply() {
    try {
      await applyTuner(activeGameId!);
      tunerSlice().applied.set(true);
      await refreshSeedAndTarget(activeGameId!);
    } catch (_e) {
      tunerSlice().failure.set('apply failed');
    }
  }

  const badge = status === 'pass' ? 'PASS' : status === 'near_miss' ? 'NEAR-MISS' : status === 'error' ? 'ERROR' : '';
  const badgeClass = status === 'pass' ? 'text-success' : status === 'near_miss' ? 'text-warning' : status === 'error' ? 'text-danger' : 'text-text-3';

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex items-center justify-between border-b border-hairline p-2">
        <span className="text-sm text-text-1">Tuner</span>
        <div className="flex gap-2">
          <button
            data-testid="tune-button"
            onClick={onTune}
            disabled={status === 'running' || !!targetGap}
            className="rounded px-3 py-1 text-sm text-text-1 hover:bg-raised-hover disabled:text-text-3"
          >
            {status === 'running' ? 'Tuning…' : 'Tune'}
          </button>
          <button
            data-testid="apply-button"
            onClick={onApply}
            disabled={!hasTunedModel || status === 'running'}
            className="rounded px-3 py-1 text-sm text-text-1 hover:bg-raised-hover disabled:text-text-3"
          >
            Apply tuned model
          </button>
        </div>
      </div>

      {targetGap && (
        <div data-testid="tuner-gap" className="border-b border-hairline p-2 text-xs text-danger">
          {targetGap}
        </div>
      )}

      <div className="border-b border-hairline p-2 text-xs text-text-2">
        <div className="mb-1 text-text-1">Seed model (tuned from this; read-only)</div>
        <pre data-testid="tuner-seed-json" className="max-h-32 overflow-auto bg-canvas p-2 font-mono text-text-1">
          {s.seedModelText.get()}
        </pre>
      </div>

      {params && (
        <div className="border-b border-hairline p-2 text-xs text-text-2">
          {(() => {
            const paramsState = tunerSlice().params.ornull;
            return (
              <>
                <label className="mr-3">
                  seed{' '}
                  <input
                    data-testid="param-master-seed"
                    type="number"
                    value={params.masterSeed}
                    onChange={(e) => paramsState?.masterSeed.set(Number(e.target.value))}
                    className="w-20 bg-canvas px-1 text-text-1"
                  />
                </label>
                <label className="mr-3">
                  population{' '}
                  <input
                    type="number"
                    value={params.population}
                    onChange={(e) => paramsState?.population.set(Number(e.target.value))}
                    className="w-16 bg-canvas px-1 text-text-1"
                  />
                </label>
                <label className="mr-3">
                  generations{' '}
                  <input
                    type="number"
                    value={params.maxGenerations}
                    onChange={(e) => paramsState?.maxGenerations.set(Number(e.target.value))}
                    className="w-16 bg-canvas px-1 text-text-1"
                  />
                </label>
                <button data-testid="toggle-advanced" onClick={() => setShowAdvanced((v) => !v)} className="text-text-2 underline">
                  {showAdvanced ? 'hide advanced' : 'advanced'}
                </button>
                {showAdvanced && (
                  <div data-testid="advanced-params" className="mt-2 flex flex-wrap gap-3">
                    <label>
                      search{' '}
                      <input
                        type="number"
                        value={params.searchCandidateCount}
                        onChange={(e) => paramsState?.searchCandidateCount.set(Number(e.target.value))}
                        className="w-24 bg-canvas px-1 text-text-1"
                      />
                    </label>
                    <label>
                      final{' '}
                      <input
                        type="number"
                        value={params.finalCandidateCount}
                        onChange={(e) => paramsState?.finalCandidateCount.set(Number(e.target.value))}
                        className="w-24 bg-canvas px-1 text-text-1"
                      />
                    </label>
                    <label>
                      mutation{' '}
                      <input
                        type="number"
                        step="0.05"
                        value={params.mutationRate}
                        onChange={(e) => paramsState?.mutationRate.set(Number(e.target.value))}
                        className="w-16 bg-canvas px-1 text-text-1"
                      />
                    </label>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {progress && (
        <div data-testid="tuning-progress" className="border-b border-hairline p-2 text-xs text-text-2">
          gen {progress.generation}/{progress.maxGenerations} · best RTP {progress.bestRtp.toFixed(4)} · fitness {progress.bestFitness.toFixed(4)}
        </div>
      )}

      <div className="flex-1 overflow-auto p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-sm text-text-2">Verdict</span>
          <span data-testid="tuning-status" className={`text-sm font-semibold ${badgeClass}`}>
            {badge}
          </span>
        </div>
        {result?.metrics && (
          <table className="text-xs text-text-1">
            <tbody>
              <tr>
                <td className="pr-4 text-text-2">Measured RTP</td>
                <td data-testid="metric-rtp">{result.metrics.rtp.toFixed(4)}</td>
              </tr>
              <tr>
                <td className="pr-4 text-text-2">Volatility</td>
                <td>{result.metrics.volatility.toFixed(3)}</td>
              </tr>
              <tr>
                <td className="pr-4 text-text-2">Hit frequency</td>
                <td>{result.metrics.hitFrequency.toFixed(4)}</td>
              </tr>
            </tbody>
          </table>
        )}
        {result && result.missed.length > 0 && (
          <div data-testid="tuner-missed" className="mt-2 text-xs text-warning">
            {result.missed.map((m) => (
              <div key={m.metric}>
                {m.metric}: measured {m.measured.toFixed(4)} band [{m.bandLo.toFixed(4)}, {m.bandHi.toFixed(4)}]
              </div>
            ))}
          </div>
        )}
        {applied && (
          <p data-testid="tuner-applied" className="mt-2 text-xs text-success">
            Applied — open the Simulator to curate &amp; sign.
          </p>
        )}
        {status === 'error' && failure && (
          <p data-testid="tuner-error" className="text-sm text-danger">
            {failure}
          </p>
        )}
      </div>
    </div>
  );
}

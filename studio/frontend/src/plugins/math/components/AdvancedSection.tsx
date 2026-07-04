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

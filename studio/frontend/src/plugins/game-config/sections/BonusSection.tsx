import { gameConfigHooks } from '../state';
import type { ISlotModel } from '../model';
import { applyModel } from '../actions';
import { addBonus, removeBonus, updateBonusConfig, updateBonusTrigger } from '../reducers';
import { validateModel } from '../validate';
import { Stepper } from '../components/Stepper';
import { CommittedInput } from '../components/CommittedInput';

export function BonusSection() {
  const s = gameConfigHooks.usePluginState();
  const model = s.model.get({ noproxy: true }) as ISlotModel;
  const issues = validateModel(model).filter((i) => i.tab === 'bonus');
  const scatters = model.symbols.filter((sd) => sd.role === 'scatter');

  return (
    <div data-testid="gc-section-bonus" className="flex flex-col gap-3 p-3">
      {model.bonuses.map((b, i) => {
        const { trigger, config } = b.FreeSpins;
        const triggerOptions = scatters.some((sd) => sd.id === trigger.symbol) ? scatters : [...scatters, { id: trigger.symbol, role: 'scatter' as const }];
        const cardIssues = issues.filter((iss) => iss.path.startsWith(`bonuses[${i}]`));
        return (
          <div key={i} data-testid={`gc-bonus-card-${i}`} className="flex flex-col gap-2 rounded-lg border border-border bg-raised p-2.5">
            <div className="flex items-center">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Free Spins {i + 1}</span>
              <button
                data-testid={`gc-bonus-delete-${i}`}
                onClick={() => applyModel((m) => removeBonus(m, i))}
                className="ml-auto rounded px-1.5 py-0.5 text-xs text-text-2 hover:bg-raised-hover hover:text-danger"
              >
                ✕
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-xs text-text-2">
              <span className="flex items-center gap-1.5">
                trigger
                <select
                  data-testid={`gc-bonus-trigger-symbol-${i}`}
                  value={trigger.symbol}
                  onChange={(e) => applyModel((m) => updateBonusTrigger(m, i, { symbol: Number(e.target.value) }))}
                  className="h-6 rounded border border-border bg-canvas px-1 text-text-1"
                >
                  {triggerOptions.map((sd) => (
                    <option key={sd.id} value={sd.id}>
                      S{sd.id}
                    </option>
                  ))}
                </select>
              </span>
              <span className="flex items-center gap-1.5">
                min count{' '}
                <Stepper
                  value={trigger.min_count}
                  min={1}
                  onChange={(v) => applyModel((m) => updateBonusTrigger(m, i, { min_count: v }))}
                  testId={`gc-bonus-min-count-${i}`}
                />
              </span>
              <span className="flex items-center gap-1.5">
                spins{' '}
                <Stepper
                  value={config.spins_awarded}
                  min={1}
                  onChange={(v) => applyModel((m) => updateBonusConfig(m, i, { spins_awarded: v }))}
                  testId={`gc-bonus-spins-${i}`}
                />
              </span>
              <span className="flex items-center gap-1.5">
                multiplier{' '}
                <CommittedInput
                  testId={`gc-bonus-multiplier-${i}`}
                  value={String(config.multiplier)}
                  kind="int"
                  onCommit={(v) => applyModel((m) => updateBonusConfig(m, i, { multiplier: parseInt(v, 10) }))}
                />
              </span>
              <label className="flex items-center gap-1.5">
                <input
                  data-testid={`gc-bonus-retrigger-${i}`}
                  type="checkbox"
                  checked={config.retrigger}
                  onChange={(e) => {
                    // Capture eagerly: React resets a controlled checkbox's DOM `checked`
                    // right after the handler returns, so a lazy `e.target.checked` read
                    // inside the applyModel closure would see the reverted value.
                    const retrigger = e.target.checked;
                    applyModel((m) => updateBonusConfig(m, i, { retrigger }));
                  }}
                />
                retrigger
              </label>
            </div>
            <span data-testid={`gc-bonus-feature-note-${i}`} className="text-[11px] text-text-3">
              Feature strips: {config.feature_reels === null ? 'base reels' : 'custom — edited in the Reels tab'}
            </span>
            {cardIssues.map((iss, k) => (
              <span key={k} data-testid={`gc-bonus-issue-${i}`} className={`text-[11px] ${iss.severity === 'error' ? 'text-danger' : 'text-warning'}`}>
                {iss.message}
              </span>
            ))}
          </div>
        );
      })}
      <button
        data-testid="gc-add-bonus"
        onClick={() => applyModel((m) => addBonus(m))}
        className="self-start rounded border border-border px-3 py-1 text-xs text-text-1 hover:bg-raised-hover"
      >
        + Add free spins feature
      </button>
    </div>
  );
}

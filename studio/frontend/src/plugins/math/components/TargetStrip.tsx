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

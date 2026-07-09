import { useState } from 'react';
import { gameStructureHooks } from '../state';
import type { IGameDefinition } from '../model';
import { applyDefinition } from '../actions';
import {
  addState,
  removeState,
  renameState,
  setStateBudget,
  toggleBinding,
  setBindingOverride,
  addScriptStep,
  removeScriptStep,
  moveScriptStep,
} from '../reducers';
import { invokeOptions } from '../vocab';
import { CommittedInput } from '../../game-config/components/CommittedInput';
import { Stepper } from '../../game-config/components/Stepper';

function OverrideEditor({
  stateId,
  stateIndex,
  bindingIndex,
  override,
}: {
  stateId: string;
  stateIndex: number;
  bindingIndex: number;
  override: Record<string, unknown> | undefined;
}) {
  const [draft, setDraft] = useState(() => (override ? JSON.stringify(override, null, 2) : ''));
  const [error, setError] = useState<string | null>(null);
  return (
    <details className="ml-5 mt-0.5">
      <summary className="cursor-pointer text-[11px] text-text-3">override</summary>
      {error && (
        <p data-testid={`gs-override-error-${stateId}-${bindingIndex}`} className="text-xs text-danger">
          {error}
        </p>
      )}
      <textarea
        data-testid={`gs-override-${stateId}-${bindingIndex}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        className="mt-1 min-h-16 w-full resize-y rounded border border-border bg-canvas p-2 font-mono text-xs text-text-1"
      />
      <button
        data-testid={`gs-override-apply-${stateId}-${bindingIndex}`}
        onClick={() => {
          const trimmed = draft.trim();
          if (trimmed === '') {
            setError(null);
            applyDefinition((d) => setBindingOverride(d, stateIndex, bindingIndex, undefined));
            return;
          }
          try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            setError(null);
            applyDefinition((d) => setBindingOverride(d, stateIndex, bindingIndex, parsed));
          } catch (e) {
            setError(e instanceof Error ? e.message : 'invalid JSON');
          }
        }}
        className="mt-1 rounded border border-border px-2 py-0.5 text-xs text-text-1 hover:bg-raised-hover"
      >
        Apply override
      </button>
    </details>
  );
}

export function StatesSection() {
  const s = gameStructureHooks.usePluginState();
  const def = s.definition.get({ noproxy: true }) as IGameDefinition;
  return (
    <div data-testid="gs-section-states" className="flex flex-col gap-3 p-3">
      {def.states.map((st, si) => (
        <div key={st.id} data-testid={`gs-state-card-${st.id}`} className="flex flex-col gap-2 rounded-lg border border-border bg-raised p-2.5">
          <div className="flex items-center gap-2">
            <CommittedInput testId={`gs-state-id-${st.id}`} value={st.id} kind="text" onCommit={(v) => applyDefinition((d) => renameState(d, si, v))} />
            <button
              data-testid={`gs-state-remove-${st.id}`}
              onClick={() => applyDefinition((d) => removeState(d, si))}
              className="ml-auto rounded px-1.5 py-0.5 text-xs text-text-2 hover:bg-raised-hover hover:text-danger"
            >
              ✕
            </button>
          </div>

          <span className="flex items-center gap-1.5 text-xs text-text-2">
            budget
            <select
              data-testid={`gs-budget-mode-${st.id}`}
              value={st.steps.budget === 'awarded' ? 'awarded' : 'fixed'}
              onChange={(e) =>
                applyDefinition((d) =>
                  e.target.value === 'awarded'
                    ? setStateBudget(d, si, 'awarded', st.steps.initial ?? 1)
                    : setStateBudget(d, si, typeof st.steps.budget === 'number' ? st.steps.budget : 1),
                )
              }
              className="h-6 rounded border border-border bg-canvas px-1 text-text-1"
            >
              <option value="fixed">fixed</option>
              <option value="awarded">awarded</option>
            </select>
            {st.steps.budget === 'awarded' ? (
              <>
                initial{' '}
                <Stepper
                  value={st.steps.initial ?? 1}
                  min={0}
                  onChange={(v) => applyDefinition((d) => setStateBudget(d, si, 'awarded', v))}
                  testId={`gs-budget-initial-${st.id}`}
                />
              </>
            ) : (
              <Stepper
                value={st.steps.budget as number}
                min={1}
                onChange={(v) => applyDefinition((d) => setStateBudget(d, si, v))}
                testId={`gs-budget-fixed-${st.id}`}
              />
            )}
          </span>

          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Bindings</span>
            {def.mechanics.map((mech) => {
              const bindingIndex = st.bindings.findIndex((b) => b.mechanic === mech.id);
              const bound = bindingIndex !== -1;
              return (
                <div key={mech.id}>
                  <label className="flex items-center gap-1.5 text-xs text-text-2">
                    <input
                      data-testid={`gs-binding-${st.id}-${mech.id}`}
                      type="checkbox"
                      checked={bound}
                      onChange={() => applyDefinition((d) => toggleBinding(d, si, mech.id))}
                    />
                    {mech.id}
                  </label>
                  {bound && <OverrideEditor stateId={st.id} stateIndex={si} bindingIndex={bindingIndex} override={st.bindings[bindingIndex].override} />}
                </div>
              );
            })}
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Script</span>
            {st.script.map((step, i) => (
              <span key={i} data-testid={`gs-script-step-${st.id}-${i}`} className="flex items-center gap-2 text-xs text-text-2">
                {step.invoke}
                <button
                  data-testid={`gs-script-up-${st.id}-${i}`}
                  onClick={() => applyDefinition((d) => moveScriptStep(d, si, i, -1))}
                  disabled={i === 0}
                  className="rounded px-1 text-text-2 hover:bg-raised-hover disabled:text-text-3"
                >
                  ↑
                </button>
                <button
                  data-testid={`gs-script-down-${st.id}-${i}`}
                  onClick={() => applyDefinition((d) => moveScriptStep(d, si, i, 1))}
                  disabled={i === st.script.length - 1}
                  className="rounded px-1 text-text-2 hover:bg-raised-hover disabled:text-text-3"
                >
                  ↓
                </button>
                <button
                  data-testid={`gs-script-remove-${st.id}-${i}`}
                  onClick={() => applyDefinition((d) => removeScriptStep(d, si, i))}
                  className="rounded px-1 text-text-2 hover:bg-raised-hover hover:text-danger"
                >
                  ✕
                </button>
              </span>
            ))}
            <select
              data-testid={`gs-script-add-${st.id}`}
              value=""
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                applyDefinition((d) => addScriptStep(d, si, v));
              }}
              className="h-6 w-fit rounded border border-border bg-canvas px-1 text-xs text-text-1"
            >
              <option value="">+ step</option>
              {invokeOptions(def, st).map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>
        </div>
      ))}
      <button
        data-testid="gs-add-state"
        onClick={() => applyDefinition(addState)}
        className="self-start rounded border border-border px-3 py-1 text-xs text-text-1 hover:bg-raised-hover"
      >
        + Add state
      </button>
    </div>
  );
}

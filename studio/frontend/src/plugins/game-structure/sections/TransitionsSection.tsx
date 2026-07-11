import { gameStructureHooks } from '../state';
import type { IGameDefinition } from '../model';
import { applyDefinition } from '../actions';
import { addTransition, removeTransition, setTransition, setStart, setMaxSteps } from '../reducers';
import { emittableEvents } from '../vocab';
import { Stepper } from '../../game-config/components/Stepper';

export function TransitionsSection() {
  const s = gameStructureHooks.usePluginState();
  const def = s.definition.get({ noproxy: true }) as IGameDefinition;
  const events = emittableEvents(def);
  const stateIds = def.states.map((st) => st.id);
  return (
    <div data-testid="gs-section-transitions" className="flex flex-col gap-3 p-3 text-xs text-text-2">
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-1.5">
          start
          <select
            data-testid="gs-start-select"
            value={def.start}
            onChange={(e) => applyDefinition((d) => setStart(d, e.target.value))}
            className="h-6 rounded border border-border bg-canvas px-1 text-text-1"
          >
            {stateIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </span>
        <span className="flex items-center gap-1.5">
          max steps <Stepper value={def.caps.max_steps} min={1} onChange={(v) => applyDefinition((d) => setMaxSteps(d, v))} testId="gs-max-steps" />
        </span>
      </div>
      {def.transitions.map((t, i) => {
        const kind = t.effect !== undefined ? 'effect' : 'to';
        const stepsAmount = t.effect ? Number(t.effect.split(':')[2] ?? 1) : 1;
        return (
          <div key={i} data-testid={`gs-tr-row-${i}`} className="flex flex-wrap items-center gap-2 rounded border border-border bg-raised p-2">
            from
            <select
              data-testid={`gs-tr-from-${i}`}
              value={t.from}
              onChange={(e) => applyDefinition((d) => setTransition(d, i, { ...t, from: e.target.value }))}
              className="h-6 rounded border border-border bg-canvas px-1 text-text-1"
            >
              {stateIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            on
            <select
              data-testid={`gs-tr-on-${i}`}
              value={t.on}
              onChange={(e) => applyDefinition((d) => setTransition(d, i, { ...t, on: e.target.value }))}
              className="h-6 rounded border border-border bg-canvas px-1 text-text-1"
            >
              <option value="">—</option>
              {events.map((ev) => (
                <option key={ev} value={ev}>
                  {ev}
                </option>
              ))}
            </select>
            <select
              data-testid={`gs-tr-kind-${i}`}
              value={kind}
              onChange={(e) =>
                applyDefinition((d) =>
                  e.target.value === 'effect'
                    ? setTransition(d, i, { from: t.from, on: t.on, effect: 'steps:add:1' })
                    : setTransition(d, i, { from: t.from, on: t.on, to: stateIds[0] ?? '' }),
                )
              }
              className="h-6 rounded border border-border bg-canvas px-1 text-text-1"
            >
              <option value="to">go to</option>
              <option value="effect">add steps</option>
            </select>
            {kind === 'to' ? (
              <select
                data-testid={`gs-tr-to-${i}`}
                value={t.to ?? ''}
                onChange={(e) => applyDefinition((d) => setTransition(d, i, { from: t.from, on: t.on, to: e.target.value }))}
                className="h-6 rounded border border-border bg-canvas px-1 text-text-1"
              >
                {stateIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            ) : (
              <Stepper
                value={stepsAmount}
                min={1}
                onChange={(v) => applyDefinition((d) => setTransition(d, i, { from: t.from, on: t.on, effect: `steps:add:${v}` }))}
                testId={`gs-tr-steps-${i}`}
              />
            )}
            <button
              data-testid={`gs-tr-remove-${i}`}
              onClick={() => applyDefinition((d) => removeTransition(d, i))}
              className="ml-auto rounded px-1.5 py-0.5 text-text-2 hover:bg-raised-hover hover:text-danger"
            >
              ✕
            </button>
          </div>
        );
      })}
      <button
        data-testid="gs-add-transition"
        onClick={() => applyDefinition(addTransition)}
        className="self-start rounded border border-border px-3 py-1 text-text-1 hover:bg-raised-hover"
      >
        + Add transition
      </button>
    </div>
  );
}

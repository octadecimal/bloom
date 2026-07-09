import { useState } from 'react';
import { gameStructureHooks } from '../state';
import type { IGameDefinition, IMechanicDecl } from '../model';
import { applyDefinition } from '../actions';
import { addMechanic, removeMechanic, renameMechanic, setMechanicConfig } from '../reducers';
import { MECHANIC_CATALOG } from '../vocab';
import { CommittedInput } from '../../game-config/components/CommittedInput';
import { Stepper } from '../../game-config/components/Stepper';

interface IReelsEventRow {
  symbol: number;
  min_count: number;
  emit: string;
}

function MeterFields({ decl, index }: { decl: IMechanicDecl; index: number }) {
  const cfg = decl.config as { target?: number; count_symbol?: number; reset_on_full?: boolean };
  const patch = (p: Record<string, unknown>) => applyDefinition((d) => setMechanicConfig(d, index, { ...d.mechanics[index].config, ...p }));
  return (
    <div className="flex flex-wrap items-center gap-4 text-xs text-text-2">
      <span className="flex items-center gap-1.5">
        target <Stepper value={cfg.target ?? 0} min={1} onChange={(v) => patch({ target: v })} testId={`gs-meter-target-${decl.id}`} />
      </span>
      <span className="flex items-center gap-1.5">
        count symbol <Stepper value={cfg.count_symbol ?? 0} onChange={(v) => patch({ count_symbol: v })} testId={`gs-meter-count-symbol-${decl.id}`} />
      </span>
      <label className="flex items-center gap-1.5">
        <input
          data-testid={`gs-meter-reset-${decl.id}`}
          type="checkbox"
          checked={cfg.reset_on_full ?? false}
          onChange={(e) => {
            const reset_on_full = e.target.checked; // capture eagerly (controlled checkbox)
            patch({ reset_on_full });
          }}
        />
        reset on full
      </label>
    </div>
  );
}

function ReelsFields({ decl, index }: { decl: IMechanicDecl; index: number }) {
  const cfg = decl.config as { rows?: number; events?: IReelsEventRow[] };
  const events = cfg.events ?? [];
  const patch = (p: Record<string, unknown>) => applyDefinition((d) => setMechanicConfig(d, index, { ...d.mechanics[index].config, ...p }));
  const patchEvent = (i: number, p: Partial<IReelsEventRow>) => patch({ events: events.map((e, k) => (k === i ? { ...e, ...p } : e)) });
  return (
    <div className="flex flex-col gap-2 text-xs text-text-2">
      <span className="flex items-center gap-1.5">
        rows <Stepper value={cfg.rows ?? 3} min={1} onChange={(v) => patch({ rows: v })} testId={`gs-reels-rows-${decl.id}`} />
      </span>
      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Events (composition seam)</span>
      {events.map((e, i) => (
        <span key={i} className="flex items-center gap-2">
          symbol <Stepper value={e.symbol} onChange={(v) => patchEvent(i, { symbol: v })} testId={`gs-reels-event-symbol-${decl.id}-${i}`} />
          min <Stepper value={e.min_count} min={1} onChange={(v) => patchEvent(i, { min_count: v })} testId={`gs-reels-event-min-${decl.id}-${i}`} />
          emit <CommittedInput testId={`gs-reels-event-emit-${decl.id}-${i}`} value={e.emit} kind="text" onCommit={(v) => patchEvent(i, { emit: v })} />
          <button
            data-testid={`gs-reels-remove-event-${decl.id}-${i}`}
            onClick={() => patch({ events: events.filter((_, k) => k !== i) })}
            className="rounded px-1.5 py-0.5 text-xs text-text-2 hover:bg-raised-hover hover:text-danger"
          >
            ✕
          </button>
        </span>
      ))}
      <button
        data-testid={`gs-reels-add-event-${decl.id}`}
        onClick={() => patch({ events: [...events, { symbol: 9, min_count: 3, emit: 'scatters:3' }] })}
        className="self-start rounded border border-border px-2 py-0.5 text-xs text-text-1 hover:bg-raised-hover"
      >
        + event
      </button>
      <span className="text-[11px] text-text-3">
        Strips / symbols / paylines / paytable: edit via config JSON below (visual editing = game-config convergence follow-up).
      </span>
    </div>
  );
}

function ConfigJson({ decl, index }: { decl: IMechanicDecl; index: number }) {
  const [draft, setDraft] = useState(() => JSON.stringify(decl.config, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-[11px] text-text-3">config JSON</summary>
      {error && (
        <p data-testid={`gs-mech-config-error-${decl.id}`} className="text-xs text-danger">
          {error}
        </p>
      )}
      <textarea
        data-testid={`gs-mech-config-json-${decl.id}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        className="mt-1 min-h-32 w-full resize-y rounded border border-border bg-canvas p-2 font-mono text-xs text-text-1"
      />
      <button
        data-testid={`gs-mech-config-apply-${decl.id}`}
        onClick={() => {
          try {
            const cfg = JSON.parse(draft) as Record<string, unknown>;
            setError(null);
            applyDefinition((d) => setMechanicConfig(d, index, cfg));
          } catch (e) {
            setError(e instanceof Error ? e.message : 'invalid JSON');
          }
        }}
        className="mt-1 rounded border border-border px-2 py-0.5 text-xs text-text-1 hover:bg-raised-hover"
      >
        Apply config
      </button>
    </details>
  );
}

export function MechanicsSection() {
  const s = gameStructureHooks.usePluginState();
  const def = s.definition.get({ noproxy: true }) as IGameDefinition;
  return (
    <div data-testid="gs-section-mechanics" className="flex flex-col gap-3 p-3">
      {def.mechanics.map((decl, i) => (
        <div key={decl.id} data-testid={`gs-mech-card-${decl.id}`} className="flex flex-col gap-2 rounded-lg border border-border bg-raised p-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{decl.type}</span>
            <CommittedInput testId={`gs-mech-id-${decl.id}`} value={decl.id} kind="text" onCommit={(v) => applyDefinition((d) => renameMechanic(d, i, v))} />
            <button
              data-testid={`gs-mech-remove-${decl.id}`}
              onClick={() => applyDefinition((d) => removeMechanic(d, i))}
              className="ml-auto rounded px-1.5 py-0.5 text-xs text-text-2 hover:bg-raised-hover hover:text-danger"
            >
              ✕
            </button>
          </div>
          {decl.type === 'meter@1' && <MeterFields decl={decl} index={i} />}
          {decl.type === 'reels@1' && <ReelsFields decl={decl} index={i} />}
          <ConfigJson decl={decl} index={i} />
        </div>
      ))}
      <div className="flex gap-2">
        {MECHANIC_CATALOG.map((c) => (
          <button
            key={c.type}
            data-testid={`gs-add-${c.type}`}
            onClick={() => applyDefinition((d) => addMechanic(d, c.type))}
            className="rounded border border-border px-3 py-1 text-xs text-text-1 hover:bg-raised-hover"
          >
            + {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

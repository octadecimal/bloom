import { gameConfigHooks } from '../state';
import type { ISlotModel, ISymbolDef } from '../model';
import type { IPresentation } from '../presentation';
import { applyModel } from '../actions';
import { addPaytableRow, removePaytableRow, updatePaytableRow } from '../reducers';
import { validateModel } from '../validate';
import { SymbolChip } from '../components/SymbolChip';
import { Stepper } from '../components/Stepper';
import { CommittedInput } from '../components/CommittedInput';

interface IPaytableGroup {
  id: number;
  sd: ISymbolDef | null; // null when the entries reference a symbol no longer in model.symbols
}

export function PaytableSection() {
  const s = gameConfigHooks.usePluginState();
  const model = s.model.get({ noproxy: true }) as ISlotModel;
  const presentation = s.presentation.get({ noproxy: true }) as IPresentation;
  const issues = validateModel(model).filter((i) => i.tab === 'paytable');

  // Group rows under their symbol in model.symbols order; entries whose symbol was
  // deleted (orphaned) still need to render somewhere so their validation issue is
  // visible — append one group per orphaned symbol id, in first-seen entry order.
  const knownIds = new Set(model.symbols.map((sd) => sd.id));
  const orphanIds = Array.from(new Set(model.paytable.entries.filter((e) => !knownIds.has(e.symbol)).map((e) => e.symbol)));
  const groups: IPaytableGroup[] = [...model.symbols.map((sd) => ({ id: sd.id, sd })), ...orphanIds.map((id) => ({ id, sd: null }))];

  return (
    <div data-testid="gc-section-paytable" className="flex flex-col gap-3 p-3">
      {groups.map(({ id, sd }) => {
        const rows = model.paytable.entries.map((e, i) => ({ e, i })).filter(({ e }) => e.symbol === id);
        return (
          <div key={id} data-testid={`gc-pt-group-${id}`} className="flex flex-col gap-1 rounded-lg border border-border bg-raised p-2.5">
            <div className="flex items-center gap-2">
              <SymbolChip presentation={presentation} id={id} />
              <span className="text-[10px] text-text-3">
                {sd === null ? 'unknown symbol — remove or reassign these rows' : sd.role === 'scatter' ? 'pays on total grid count' : 'left-aligned run'}
              </span>
              {sd !== null && (
                <button
                  data-testid={`gc-add-pt-row-${id}`}
                  onClick={() => applyModel((m) => addPaytableRow(m, id))}
                  className="ml-auto rounded border border-border px-2 py-0.5 text-xs text-text-2 hover:bg-raised-hover"
                >
                  + row
                </button>
              )}
            </div>
            {rows.map(({ e, i }) => {
              const rowIssues = issues.filter((iss) => iss.path === `paytable.entries[${i}]`);
              return (
                <div key={i} data-testid={`gc-pt-row-${i}`} className="flex items-center gap-3 pl-1 text-xs text-text-1">
                  <span className="flex items-center gap-1.5 text-text-2">
                    count{' '}
                    <Stepper value={e.count} min={1} onChange={(v) => applyModel((m) => updatePaytableRow(m, i, { count: v }))} testId={`gc-pt-count-${i}`} />
                  </span>
                  <span className="flex items-center gap-1.5 text-text-2">
                    payout{' '}
                    <CommittedInput
                      testId={`gc-pt-payout-${i}`}
                      value={String(e.payout)}
                      kind="int"
                      onCommit={(v) => applyModel((m) => updatePaytableRow(m, i, { payout: parseInt(v, 10) }))}
                    />
                  </span>
                  <button
                    data-testid={`gc-pt-delete-${i}`}
                    onClick={() => applyModel((m) => removePaytableRow(m, i))}
                    className="rounded px-1.5 py-0.5 text-text-2 hover:bg-raised-hover hover:text-danger"
                  >
                    ✕
                  </button>
                  {rowIssues.map((iss, k) => (
                    <span key={k} data-testid={`gc-pt-issue-${i}`} className={`text-[11px] ${iss.severity === 'error' ? 'text-danger' : 'text-warning'}`}>
                      {iss.message}
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

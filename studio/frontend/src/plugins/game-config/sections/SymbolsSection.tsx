import { gameConfigHooks } from '../state';
import type { ISlotModel, SymbolRole } from '../model';
import { applyModel, applyPresentation } from '../actions';
import { addSymbol, removeSymbol, setSymbolRole } from '../reducers';
import { SWATCHES, SWATCH_DOT_CLASS, symbolColor, symbolLabel, type IPresentation } from '../presentation';
import { CommittedInput } from '../components/CommittedInput';

const ROLES: SymbolRole[] = ['normal', 'wild', 'scatter'];

export function SymbolsSection() {
  const s = gameConfigHooks.usePluginState();
  const model = s.model.get({ noproxy: true }) as ISlotModel;
  const presentation = s.presentation.get({ noproxy: true }) as IPresentation;

  return (
    <div data-testid="gc-section-symbols" className="flex flex-col gap-1 p-3">
      {model.symbols.map((sym) => (
        <div
          key={sym.id}
          data-testid={`gc-symbol-row-${sym.id}`}
          className="flex items-center gap-2 rounded-lg border border-border bg-raised px-2.5 py-1.5"
        >
          <span className="flex items-center gap-1">
            {SWATCHES.map((sw) => (
              <button
                key={sw}
                data-testid={`gc-symbol-swatch-${sym.id}-${sw}`}
                title={sw}
                onClick={() =>
                  applyPresentation((p) => ({
                    symbols: { ...p.symbols, [String(sym.id)]: { label: symbolLabel(p, sym.id), color: sw } },
                  }))
                }
                className={`h-3 w-3 rounded-full ${SWATCH_DOT_CLASS[sw]} ${
                  symbolColor(presentation, sym.id) === sw ? 'ring-2 ring-ring' : 'opacity-40 hover:opacity-100'
                }`}
              />
            ))}
          </span>
          <CommittedInput
            testId={`gc-symbol-label-${sym.id}`}
            value={symbolLabel(presentation, sym.id)}
            kind="text"
            onCommit={(label) =>
              applyPresentation((p) => ({
                symbols: { ...p.symbols, [String(sym.id)]: { label, color: symbolColor(p, sym.id) } },
              }))
            }
          />
          <select
            data-testid={`gc-symbol-role-${sym.id}`}
            value={sym.role}
            onChange={(e) => applyModel((m) => setSymbolRole(m, sym.id, e.target.value as SymbolRole))}
            className="h-6 rounded border border-border bg-canvas px-1 text-xs text-text-1"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <span className="ml-auto font-mono text-[10px] text-text-3">id {sym.id}</span>
          <button
            data-testid={`gc-symbol-delete-${sym.id}`}
            onClick={() => applyModel((m) => removeSymbol(m, sym.id))}
            className="rounded px-1.5 py-0.5 text-xs text-text-2 hover:bg-raised-hover hover:text-danger"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        data-testid="gc-add-symbol"
        onClick={() => applyModel((m) => addSymbol(m))}
        className="mt-1 self-start rounded border border-border px-3 py-1 text-xs text-text-1 hover:bg-raised-hover"
      >
        + Add symbol
      </button>
    </div>
  );
}

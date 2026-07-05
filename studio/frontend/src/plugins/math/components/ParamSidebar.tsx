import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { TooltipProvider } from '../../../components/ui/tooltip';
import { mathSlice } from '../state';
import { PARAM_FIELDS, PARAM_GROUPS, resetGroup } from './paramFields';
import { ParamField } from './ParamField';

const STORAGE_KEY = 'bloom.math.sidebar';

/** Sidebar visibility, persisted per user (UI preference, not game data). */
export function useParamSidebarOpen(): [boolean, () => void] {
  const [open, setOpen] = useState(() => localStorage.getItem(STORAGE_KEY) === '1');
  const toggle = () =>
    setOpen((v) => {
      const next = !v;
      localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      return next;
    });
  return [open, toggle];
}

/** The first-class params column (the old AdvancedSection, promoted). Edits
 * land in the slice; they persist via the PUT that precedes every Generate
 * (tuner_params) / Verify (params) — see actions.ts. */
export function ParamSidebar() {
  return (
    <div data-testid="advanced-params" className="w-60 flex-none overflow-y-auto border-l border-hairline p-3">
      <TooltipProvider delayDuration={300}>
        <div className="flex flex-col gap-4">
          {PARAM_GROUPS.map((g) => (
            <section key={g.id}>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wide text-text-2">{g.label}</span>
                <button
                  type="button"
                  data-testid={`param-reset-${g.id}`}
                  title={`Reset ${g.label.toLowerCase()} to defaults`}
                  aria-label={`Reset ${g.label.toLowerCase()} to defaults`}
                  onClick={() => resetGroup(mathSlice(), g.id)}
                  className="rounded p-0.5 text-text-3 hover:bg-raised-hover hover:text-text-1"
                >
                  <RotateCcw className="h-3 w-3" />
                </button>
              </div>
              <div className="flex flex-col gap-1.5">
                {PARAM_FIELDS.filter((f) => f.group === g.id).map((f) => (
                  <ParamField key={f.key} def={f} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </TooltipProvider>
    </div>
  );
}

import { RotateCcw } from 'lucide-react';
import { TooltipProvider } from '../../../components/ui/tooltip';
import { mathSlice } from '../state';
import { PARAM_FIELDS, PARAM_GROUPS, resetGroup } from './paramFields';
import { ParamField } from './ParamField';

/** The params column CONTENT; the resizable shell around it is
 * components/ui/PaneSidebar (MathPane composes the two). Edits land in the
 * slice; they persist via the PUT that precedes every Generate
 * (tuner_params) / Verify (params) — see actions.ts. */
export function ParamSidebar() {
  return (
    <div data-testid="advanced-params" className="p-3">
      <TooltipProvider delayDuration={300}>
        <div className="flex flex-col gap-4">
          {PARAM_GROUPS.map((g) => (
            <section key={g.id}>
              <div className="mb-2 flex items-center justify-between border-b border-hairline pb-1.5">
                <span className="text-[10px] uppercase tracking-wide text-text-1">{g.label}</span>
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

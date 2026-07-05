import { useState } from 'react';
import { ChevronDown, ChevronUp, Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import { mathHooks, mathSlice } from '../state';
import type { IParamFieldDef } from './paramFields';

export function clampToDef(v: number, def: IParamFieldDef): number {
  let x = def.integer ? Math.round(v) : v;
  if (def.min !== undefined && x < def.min) x = def.min;
  if (def.max !== undefined && x > def.max) x = def.max;
  return x;
}

export function formatValue(v: number, def: IParamFieldDef): string {
  return def.integer && Math.abs(v) >= 1000 ? v.toLocaleString('en-US') : String(v);
}

function inRange(v: number, def: IParamFieldDef): boolean {
  return Number.isFinite(v) && (def.min === undefined || v >= def.min) && (def.max === undefined || v <= def.max);
}

const parse = (raw: string): number => (raw.trim() === '' ? NaN : Number(raw));

/** One registry-driven param row: tooltip'd label + validated number input with
 * design-language steppers. Must render inside a TooltipProvider. */
export function ParamField({ def }: { def: IParamFieldDef }) {
  const s = mathHooks.usePluginState();
  // Raw text while the user is editing; null = not editing (show formatted slice value).
  const [draft, setDraft] = useState<string | null>(null);
  const value = def.get(s);
  if (value === null) return null;

  const invalid = draft !== null && !inRange(parse(draft), def);
  const commit = (v: number) => def.set(mathSlice(), clampToDef(v, def));

  const step = (dir: 1 | -1) => {
    setDraft(null);
    // toFixed dodges float drift (0.25 + 0.05 → 0.30000000000000004).
    commit(Number((value + dir * def.step).toFixed(6)));
  };

  return (
    <label className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="flex w-24 flex-none cursor-help items-center gap-1 text-[10px] uppercase tracking-wide text-text-2 outline-none focus-visible:text-text-1"
          >
            <span className="truncate">{def.label}</span>
            <Info className="h-3 w-3 flex-none text-text-3" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="left">
          <div className="text-text-1">{def.tooltip.title}</div>
          <div className="mt-1">{def.tooltip.body}</div>
          <div className="mt-1">{def.tooltip.effect}</div>
          <div className="mt-1 text-text-3">
            Default: {formatValue(def.defaultValue, def)}
            {def.unit ? ` ${def.unit}` : ''}
          </div>
        </TooltipContent>
      </Tooltip>
      <div
        data-testid={`param-${def.key}-wrap`}
        data-invalid={invalid || undefined}
        className={`flex h-7 min-w-0 flex-1 items-center overflow-hidden rounded border bg-raised focus-within:ring-2 focus-within:ring-ring ${invalid ? 'border-danger' : 'border-hairline'}`}
      >
        <input
          data-testid={`param-${def.key}`}
          type="text"
          inputMode="decimal"
          value={draft ?? formatValue(value, def)}
          onFocus={() => setDraft(String(value))}
          onChange={(e) => {
            setDraft(e.target.value);
            const n = parse(e.target.value);
            if (inRange(n, def)) def.set(mathSlice(), def.integer ? Math.round(n) : n);
          }}
          onBlur={() => {
            if (draft !== null && Number.isFinite(parse(draft))) commit(parse(draft));
            setDraft(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') (e.preventDefault(), step(1));
            if (e.key === 'ArrowDown') (e.preventDefault(), step(-1));
          }}
          className="w-full min-w-0 bg-transparent px-2 text-[13px] text-text-1 outline-none"
        />
        {def.unit && <span className="flex-none pr-1.5 text-[10px] text-text-3">{def.unit}</span>}
        <div className="flex h-full flex-none flex-col border-l border-hairline">
          <button
            type="button"
            data-testid={`param-${def.key}-up`}
            tabIndex={-1}
            aria-label={`increase ${def.label}`}
            onClick={() => step(1)}
            className="flex h-1/2 w-5 items-center justify-center text-text-3 hover:bg-raised-hover hover:text-text-1"
          >
            <ChevronUp className="h-3 w-3" />
          </button>
          <button
            type="button"
            data-testid={`param-${def.key}-down`}
            tabIndex={-1}
            aria-label={`decrease ${def.label}`}
            onClick={() => step(-1)}
            className="flex h-1/2 w-5 items-center justify-center border-t border-hairline text-text-3 hover:bg-raised-hover hover:text-text-1"
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </div>
      </div>
    </label>
  );
}

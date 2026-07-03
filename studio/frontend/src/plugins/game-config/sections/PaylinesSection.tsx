import { gameConfigHooks } from '../state';
import type { ISlotModel } from '../model';
import { applyModel } from '../actions';
import { addPayline, duplicatePayline, removePayline, setPaylineCell } from '../reducers';
import { validateModel } from '../validate';

function CellGrid({
  rows,
  reels,
  isOn,
  onClick,
  cellTestId,
}: {
  rows: number;
  reels: number;
  isOn: (reel: number, row: number) => boolean;
  onClick?: (reel: number, row: number) => void;
  cellTestId: (reel: number, row: number) => string;
}) {
  return (
    <div className="flex gap-1">
      {Array.from({ length: reels }, (_, reel) => (
        <div key={reel} className="flex flex-col gap-1">
          {Array.from({ length: rows }, (_, row) => (
            <button
              key={row}
              data-testid={cellTestId(reel, row)}
              onClick={onClick ? () => onClick(reel, row) : undefined}
              disabled={!onClick}
              className={`h-6 w-6 rounded border text-[10px] ${
                isOn(reel, row) ? 'border-primary bg-selection text-selection-text' : 'border-border bg-canvas text-text-3'
              } ${onClick ? 'hover:border-border-strong' : ''}`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function PaylinesSection() {
  const s = gameConfigHooks.usePluginState();
  const model = s.model.get({ noproxy: true }) as ISlotModel;
  const issues = validateModel(model).filter((i) => i.tab === 'paylines');
  const reels = model.reels.length;

  return (
    <div data-testid="gc-section-paylines" className="flex flex-wrap items-start gap-3 p-3">
      {model.paylines.map((line, i) => {
        const lineIssues = issues.filter((iss) => iss.path === `paylines[${i}]`);
        return (
          <div key={i} data-testid={`gc-payline-card-${i}`} className="flex flex-col gap-2 rounded-lg border border-border bg-raised p-2.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Line {i + 1}</span>
              <button
                data-testid={`gc-dup-payline-${i}`}
                onClick={() => applyModel((m) => duplicatePayline(m, i))}
                className="ml-auto rounded px-1.5 py-0.5 text-xs text-text-2 hover:bg-raised-hover"
              >
                ⧉
              </button>
              <button
                data-testid={`gc-del-payline-${i}`}
                onClick={() => applyModel((m) => removePayline(m, i))}
                className="rounded px-1.5 py-0.5 text-xs text-text-2 hover:bg-raised-hover hover:text-danger"
              >
                ✕
              </button>
            </div>
            <CellGrid
              rows={model.rows}
              reels={reels}
              isOn={(reel, row) => line[reel] === row}
              onClick={(reel, row) => applyModel((m) => setPaylineCell(m, i, reel, row))}
              cellTestId={(reel, row) => `gc-pl-cell-${i}-${reel}-${row}`}
            />
            {lineIssues.map((iss, k) => (
              <span key={k} data-testid={`gc-payline-issue-${i}`} className="text-[11px] text-danger">
                {iss.message}
              </span>
            ))}
          </div>
        );
      })}

      <button
        data-testid="gc-add-payline"
        onClick={() => applyModel((m) => addPayline(m))}
        className="rounded border border-border px-3 py-1 text-xs text-text-1 hover:bg-raised-hover"
      >
        + Add line
      </button>

      <div data-testid="gc-lines-overview" className="flex flex-col gap-2 rounded-lg border border-border bg-raised p-2.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">All lines</span>
        <div className="flex gap-1">
          {Array.from({ length: reels }, (_, reel) => (
            <div key={reel} className="flex flex-col gap-1">
              {Array.from({ length: model.rows }, (_, row) => {
                const n = model.paylines.filter((l) => l[reel] === row).length;
                return (
                  <span
                    key={row}
                    data-testid={`gc-ov-cell-${reel}-${row}`}
                    className={`flex h-6 w-6 items-center justify-center rounded border text-[10px] ${
                      n > 0 ? 'border-primary bg-selection text-selection-text' : 'border-border bg-canvas text-text-3'
                    }`}
                  >
                    {n > 0 ? n : ''}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

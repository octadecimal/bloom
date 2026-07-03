import { useState } from 'react';
import { gameConfigHooks } from '../state';
import type { ISlotModel } from '../model';
import type { IPresentation } from '../presentation';
import { applyModel } from '../actions';
import {
  getStrips,
  countOccurrences,
  insertStripCell,
  replaceStripCell,
  removeStripCell,
  moveStripCell,
  appendStripCell,
  setSymbolCount,
  setRows,
  setReelCount,
  addFeatureReels,
  clearFeatureReels,
  type ReelSetRef,
} from '../reducers';
import { SymbolChip } from '../components/SymbolChip';
import { Stepper } from '../components/Stepper';

export function ReelsSection() {
  const s = gameConfigHooks.usePluginState();
  const model = s.model.get({ noproxy: true }) as ISlotModel;
  const presentation = s.presentation.get({ noproxy: true }) as IPresentation;
  const lens = s.reelLens.get();
  const ref = s.activeReelSet.get() as ReelSetRef;
  const [openCell, setOpenCell] = useState<{ reel: number; index: number } | null>(null);
  const [dragFrom, setDragFrom] = useState<{ reel: number; index: number } | null>(null);

  const strips = getStrips(model, ref);
  const lensBtn = (active: boolean) => `px-3 py-1 text-xs ${active ? 'border-b-2 border-primary text-text-1' : 'text-text-2 hover:text-text-1'}`;

  return (
    <div data-testid="gc-section-reels" className="flex flex-col gap-2 p-3">
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-2 text-xs text-text-2">
          Rows <Stepper value={model.rows} min={1} max={8} onChange={(v) => applyModel((m) => setRows(m, v))} testId="gc-rows-stepper" />
        </span>
        <span className="flex items-center gap-2 text-xs text-text-2">
          Reels <Stepper value={model.reels.length} min={1} max={8} onChange={(v) => applyModel((m) => setReelCount(m, v))} testId="gc-reels-stepper" />
        </span>
        <select
          data-testid="gc-reelset-select"
          value={ref === 'base' ? 'base' : `bonus-${ref}`}
          onChange={(e) => s.activeReelSet.set(e.target.value === 'base' ? 'base' : Number(e.target.value.slice(6)))}
          className="h-6 rounded border border-border bg-canvas px-1 text-xs text-text-1"
        >
          <option value="base">Base reels</option>
          {model.bonuses.map((_, i) => (
            <option key={i} value={`bonus-${i}`}>
              FreeSpins {i + 1} feature reels
            </option>
          ))}
        </select>
        <span className="ml-auto">
          <button data-testid="gc-lens-strip" className={lensBtn(lens === 'strip')} onClick={() => s.reelLens.set('strip')}>
            Strip
          </button>
          <button data-testid="gc-lens-composition" className={lensBtn(lens === 'composition')} onClick={() => s.reelLens.set('composition')}>
            Composition
          </button>
        </span>
      </div>

      {ref !== 'base' && strips === null && (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-border bg-raised p-3 text-xs text-text-2">
          This bonus uses the base reels during free spins.
          <button
            data-testid="gc-add-feature-reels"
            onClick={() => applyModel((m) => addFeatureReels(m, ref))}
            className="rounded border border-border px-3 py-1 text-text-1 hover:bg-raised-hover"
          >
            Add feature strips (clone base)
          </button>
        </div>
      )}

      {strips !== null && (
        <>
          {ref !== 'base' && (
            <button
              data-testid="gc-clear-feature-reels"
              onClick={() => applyModel((m) => clearFeatureReels(m, ref))}
              className="self-start rounded border border-border px-3 py-1 text-xs text-text-2 hover:bg-raised-hover"
            >
              Revert to base (remove feature strips)
            </button>
          )}

          {lens === 'strip' ? (
            <div className="flex items-start gap-3 overflow-x-auto">
              {strips.map((strip, r) => (
                <div key={r} data-testid={`gc-strip-col-${r}`} className="flex min-w-24 flex-col gap-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                    R{r + 1} · {strip.length}
                  </span>
                  {strip.map((sym, i) => (
                    <span key={i} className="relative">
                      <button
                        data-testid={`gc-strip-cell-${r}-${i}`}
                        draggable
                        onDragStart={() => setDragFrom({ reel: r, index: i })}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => {
                          if (dragFrom && dragFrom.reel === r) applyModel((m) => moveStripCell(m, ref, r, dragFrom.index, i));
                          setDragFrom(null);
                        }}
                        onClick={() => setOpenCell(openCell?.reel === r && openCell.index === i ? null : { reel: r, index: i })}
                        className="w-full rounded hover:bg-raised-hover"
                      >
                        <SymbolChip presentation={presentation} id={sym} />
                      </button>
                      {openCell?.reel === r && openCell.index === i && (
                        <div
                          data-testid="gc-cell-menu"
                          className="absolute left-full top-0 z-10 ml-1 flex w-40 flex-col gap-1 rounded-lg border border-border-strong bg-popover p-2"
                        >
                          <span className="text-[10px] uppercase text-muted-foreground">Replace with</span>
                          <span className="flex flex-wrap gap-1">
                            {model.symbols.map((sd) => (
                              <button
                                key={sd.id}
                                data-testid={`gc-cell-replace-${sd.id}`}
                                onClick={() => {
                                  applyModel((m) => replaceStripCell(m, ref, r, i, sd.id));
                                  setOpenCell(null);
                                }}
                              >
                                <SymbolChip presentation={presentation} id={sd.id} />
                              </button>
                            ))}
                          </span>
                          <button
                            data-testid="gc-cell-insert-after"
                            onClick={() => {
                              applyModel((m) => insertStripCell(m, ref, r, i + 1, sym));
                              setOpenCell(null);
                            }}
                            className="rounded px-1.5 py-0.5 text-left text-xs text-text-1 hover:bg-raised-hover"
                          >
                            Insert copy after
                          </button>
                          <button
                            data-testid="gc-cell-remove"
                            onClick={() => {
                              applyModel((m) => removeStripCell(m, ref, r, i));
                              setOpenCell(null);
                            }}
                            className="rounded px-1.5 py-0.5 text-left text-xs text-danger hover:bg-raised-hover"
                          >
                            Remove
                          </button>
                        </div>
                      )}
                    </span>
                  ))}
                  <button
                    data-testid={`gc-strip-add-${r}`}
                    onClick={() => model.symbols[0] && applyModel((m) => appendStripCell(m, ref, r, model.symbols[0].id))}
                    className="rounded border border-border px-2 py-0.5 text-xs text-text-2 hover:bg-raised-hover"
                  >
                    +
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <table className="w-fit text-xs text-text-1">
              <thead>
                <tr>
                  <th className="pr-3 text-left text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Symbol</th>
                  {strips.map((_, r) => (
                    <th key={r} className="px-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                      R{r + 1}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {model.symbols.map((sd) => (
                  <tr key={sd.id}>
                    <td className="py-0.5 pr-3">
                      <SymbolChip presentation={presentation} id={sd.id} />
                    </td>
                    {strips.map((strip, r) => (
                      <td key={r} className="px-2 py-0.5">
                        <Stepper
                          value={countOccurrences(strip, sd.id)}
                          onChange={(v) => applyModel((m) => setSymbolCount(m, ref, r, sd.id, v))}
                          testId={`gc-comp-count-${sd.id}-${r}`}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className="border-t border-hairline text-text-2">
                  <td className="py-0.5 pr-3">strip length</td>
                  {strips.map((strip, r) => (
                    <td key={r} data-testid={`gc-strip-len-${r}`} className="px-2 text-center font-mono">
                      {strip.length}
                    </td>
                  ))}
                </tr>
                {model.symbols.map((sd) => (
                  <tr key={`freq-${sd.id}`} className="text-text-3">
                    <td className="py-0.5 pr-3">
                      {`freq `}
                      <SymbolChip presentation={presentation} id={sd.id} />
                    </td>
                    {strips.map((strip, r) => (
                      <td key={r} data-testid={`gc-freq-${sd.id}-${r}`} className="px-2 text-center font-mono">
                        {strip.length === 0 ? '—' : `${Math.round((100 * countOccurrences(strip, sd.id)) / strip.length)}%`}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

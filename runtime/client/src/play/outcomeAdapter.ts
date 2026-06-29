import type { IOutcome } from '../modules/module';
import type { ISpinResponse } from './wireTypes';

/** Map the server's slots@1 wire outcome to the client's IOutcome. The server's
 *  base_grid[reel][row] orientation already matches IOutcome.grid[col][row], so
 *  this is a pure stringify of the u8 symbol ids — no transpose. */
export function toClientOutcome(res: ISpinResponse): IOutcome {
  const o = res.outcome;
  if (o.mechanic !== 'slots@1') {
    throw new Error(`unsupported mechanic: ${o.mechanic}`);
  }
  return { grid: o.base_grid.map((reel) => reel.map((sym) => String(sym))) };
}

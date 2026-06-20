import type { ILayoutPresetsService } from '../host/layoutPresets';

let current: ILayoutPresetsService | null = null;

export function setLayoutPresets(s: ILayoutPresetsService): void {
  current = s;
}

export function getLayoutPresets(): ILayoutPresetsService {
  if (!current) throw new Error('Layout presets not initialised — call setLayoutPresets() during boot.');
  return current;
}

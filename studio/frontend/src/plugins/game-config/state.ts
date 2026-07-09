import type { State } from '@hookstate/core';
import { rootStore } from '../../state/rootStore';
import { makePluginHooks } from '../../state/makePluginHooks';
import type { ISlotModel } from './model';
import { emptyPresentation, type IPresentation } from './presentation';
import type { GcTab } from './validate';
import type { ReelSetRef } from './reducers';

export const GAME_CONFIG_PLUGIN_ID = 'game-config';

export type GcLens = 'strip' | 'composition';
export type GcSync = 'idle' | 'saving' | 'saved' | 'external' | 'error';

export interface ISectionLocks {
  reels: boolean;
  paytable: boolean;
  bonus: boolean;
}

export function defaultLocks(): ISectionLocks {
  return { reels: false, paytable: false, bonus: false };
}

export interface IGameConfigState {
  activeGameId: string | null;
  model: ISlotModel | null;
  presentation: IPresentation;
  locks: ISectionLocks;
  jsonDraft: string;
  jsonError: string | null;
  activeTab: GcTab;
  reelLens: GcLens;
  activeReelSet: ReelSetRef;
  sync: GcSync;
  externalSource: string | null;
  watermark: string; // updatedAt of the last state we hydrated; older socket events are ignored
  loadStatus: 'idle' | 'loading' | 'error';
  /** True when the GDD's declared shape no longer matches the realized model
   * (spec 2026-07-09 §5) — display-only here; the re-realize affordance lives
   * in the GDD viewer (Task 8). */
  shapeStale: boolean;
}

export function makeInitialState(): IGameConfigState {
  return {
    activeGameId: null,
    model: null,
    presentation: emptyPresentation(),
    locks: defaultLocks(),
    jsonDraft: '',
    jsonError: null,
    activeTab: 'symbols',
    reelLens: 'strip',
    activeReelSet: 'base',
    sync: 'idle',
    externalSource: null,
    watermark: '',
    loadStatus: 'idle',
    shapeStale: false,
  };
}

export const gameConfigHooks = makePluginHooks<IGameConfigState>(GAME_CONFIG_PLUGIN_ID);

export function gameConfigSlice(): State<IGameConfigState> {
  return rootStore.plugins.nested(GAME_CONFIG_PLUGIN_ID) as unknown as State<IGameConfigState>;
}

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

export interface IGameConfigState {
  activeGameId: string | null;
  model: ISlotModel | null;
  presentation: IPresentation;
  jsonDraft: string;
  jsonError: string | null;
  activeTab: GcTab;
  reelLens: GcLens;
  activeReelSet: ReelSetRef;
  sync: GcSync;
  externalSource: string | null;
  watermark: string; // updatedAt of the last state we hydrated; older socket events are ignored
  loadStatus: 'idle' | 'loading' | 'error';
}

export function makeInitialState(): IGameConfigState {
  return {
    activeGameId: null,
    model: null,
    presentation: emptyPresentation(),
    jsonDraft: '',
    jsonError: null,
    activeTab: 'symbols',
    reelLens: 'strip',
    activeReelSet: 'base',
    sync: 'idle',
    externalSource: null,
    watermark: '',
    loadStatus: 'idle',
  };
}

export const gameConfigHooks = makePluginHooks<IGameConfigState>(GAME_CONFIG_PLUGIN_ID);

export function gameConfigSlice(): State<IGameConfigState> {
  return rootStore.plugins.nested(GAME_CONFIG_PLUGIN_ID) as unknown as State<IGameConfigState>;
}

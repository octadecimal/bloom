import type { State } from '@hookstate/core';
import { rootStore } from '../../state/rootStore';
import { makePluginHooks } from '../../state/makePluginHooks';
import type { IGameDefinition } from './model';
import type { IComposeMetrics } from './restClient';

export const GAME_STRUCTURE_PLUGIN_ID = 'game-structure';

export type GsTab = 'mechanics' | 'states' | 'transitions' | 'json';
export type GsSync = 'idle' | 'saving' | 'saved' | 'external' | 'error';

export interface IGameStructureState {
  activeGameId: string | null;
  definition: IGameDefinition | null;
  presentation: Record<string, unknown>;
  jsonDraft: string;
  jsonError: string | null;
  activeTab: GsTab;
  sync: GsSync;
  externalSource: string | null;
  watermark: string; // updatedAt of the last state we hydrated; older socket events are ignored
  loadStatus: 'idle' | 'loading' | 'error';
  validation: { status: 'idle' | 'checking' | 'ok' | 'errors'; errors: string[] };
  build: { status: 'idle' | 'building' | 'done' | 'error'; metrics: IComposeMetrics | null; errors: string[] };
}

export function makeInitialState(): IGameStructureState {
  return {
    activeGameId: null,
    definition: null,
    presentation: {},
    jsonDraft: '',
    jsonError: null,
    activeTab: 'mechanics',
    sync: 'idle',
    externalSource: null,
    watermark: '',
    loadStatus: 'idle',
    validation: { status: 'idle', errors: [] },
    build: { status: 'idle', metrics: null, errors: [] },
  };
}

export const gameStructureHooks = makePluginHooks<IGameStructureState>(GAME_STRUCTURE_PLUGIN_ID);

export function gameStructureSlice(): State<IGameStructureState> {
  return rootStore.plugins.nested(GAME_STRUCTURE_PLUGIN_ID) as unknown as State<IGameStructureState>;
}

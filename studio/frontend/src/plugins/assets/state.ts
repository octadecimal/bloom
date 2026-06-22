// studio/frontend/src/plugins/assets/state.ts
import type { State } from '@hookstate/core';
import { rootStore } from '../../state/rootStore';
import { makePluginHooks } from '../../state/makePluginHooks';

export const ASSETS_PLUGIN_ID = 'assets';

export type AssetStatus = 'idle' | 'queued' | 'generating' | 'done' | 'error';
export type Workflow = 'schnell-opaque' | 'schnell-transparent' | 'dev-transparent';

export interface IGeneration {
  id: string;
  seed: number;
  imageRef: string;
  createdAt: string;
}

export interface IProgress {
  value: number;
  max: number;
}

export interface IAsset {
  id: string;
  gameId: string;
  name: string;
  category: string | null;
  prompt: string;
  width: number;
  height: number;
  workflow: Workflow;
  seed: number | null;
  status: AssetStatus;
  generations: IGeneration[];
  selectedGenerationId: string | null;
  error: string | null;
  progress: IProgress | null; // transient, client-only (from asset_progress)
}

export interface IAssetsState {
  connection: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  activeGameId: string | null;
  assets: IAsset[];
  assetsStatus: 'idle' | 'loading' | 'error';
}

export function makeInitialState(): IAssetsState {
  return {
    connection: 'connecting',
    activeGameId: null,
    assets: [],
    assetsStatus: 'idle',
  };
}

export const assetsHooks = makePluginHooks<IAssetsState>(ASSETS_PLUGIN_ID);

export function assetsSlice(): State<IAssetsState> {
  return rootStore.plugins.nested(ASSETS_PLUGIN_ID) as unknown as State<IAssetsState>;
}

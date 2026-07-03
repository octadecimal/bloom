import type { State } from '@hookstate/core';
import { rootStore } from '../../state/rootStore';
import { makePluginHooks } from '../../state/makePluginHooks';

export const SIMULATOR_PLUGIN_ID = 'simulator';

export interface ICurationParams {
  poolSize: number;
  candidateCount: number;
  masterSeed: number;
  rtpTolerance: number;
  realizedCorrectionBand: number;
  bonusRateTolerance: number;
}

export interface IMetrics {
  rtp: number;
  volatility: number;
  hitFrequency: number;
  baseRtp: number;
  featureRtp: number;
  bonusHitRates: number[];
}

export interface ICurationResult {
  status: 'pass' | 'fail' | 'error';
  metrics: IMetrics;
  realizedRtp: number | null;
  poolSize: number | null;
  failure: string | null;
  ranAt: string;
}

export interface ISlotModelDoc {
  id: string;
  gameId: string;
  model: unknown;
  params: ICurationParams;
  result: ICurationResult | null;
}

export interface ISimulatorState {
  connection: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  activeGameId: string | null;
  params: ICurationParams | null;
  status: 'idle' | 'running' | 'pass' | 'fail' | 'error';
  progress: { phase: string; done: number | null; total: number | null } | null;
  result: ICurationResult | null;
  failure: string | null;
  loadStatus: 'idle' | 'loading' | 'error';
}

export function makeInitialState(): ISimulatorState {
  return {
    connection: 'disconnected',
    activeGameId: null,
    params: null,
    status: 'idle',
    progress: null,
    result: null,
    failure: null,
    loadStatus: 'idle',
  };
}

export const simulatorHooks = makePluginHooks<ISimulatorState>(SIMULATOR_PLUGIN_ID);

export function simulatorSlice(): State<ISimulatorState> {
  return rootStore.plugins.nested(SIMULATOR_PLUGIN_ID) as unknown as State<ISimulatorState>;
}

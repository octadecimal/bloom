import type { State } from '@hookstate/core';
import { rootStore } from '../../state/rootStore';
import { makePluginHooks } from '../../state/makePluginHooks';

export const TUNER_PLUGIN_ID = 'tuner';

export interface ITuneWeights {
  rtp: number;
  volatility: number;
  hitRate: number;
}

export interface ITuningParams {
  masterSeed: number;
  population: number;
  maxGenerations: number;
  searchCandidateCount: number;
  finalCandidateCount: number;
  elitism: number;
  mutationRate: number;
  crossoverRate: number;
  stagnationWindow: number;
  weights: ITuneWeights;
}

export interface IMetrics {
  rtp: number;
  volatility: number;
  hitFrequency: number;
  baseRtp: number;
  featureRtp: number;
  bonusHitRates: number[];
}

export interface IBandMiss {
  metric: string;
  measured: number;
  bandLo: number;
  bandHi: number;
}

export interface IGenSnapshot {
  generation: number;
  bestFitness: number;
  bestRtp: number;
  bestVolatility: number;
}

export interface ITuneResult {
  status: 'pass' | 'near_miss' | 'error';
  verdict: 'pass' | 'near_miss' | null;
  tunedModel: unknown | null;
  metrics: IMetrics | null;
  missed: IBandMiss[];
  trace: IGenSnapshot[];
  failure: string | null;
  ranAt: string;
}

export interface ITunerJobDoc {
  id: string;
  gameId: string;
  params: ITuningParams;
  result: ITuneResult | null;
}

export interface ITunerProgress {
  generation: number;
  maxGenerations: number;
  bestFitness: number;
  bestRtp: number;
  bestVolatility: number;
}

export interface ITunerState {
  connection: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  activeGameId: string | null;
  seedModelText: string;
  params: ITuningParams | null;
  derivedTarget: unknown | null;
  targetGap: string | null;
  status: 'idle' | 'running' | 'pass' | 'near_miss' | 'error';
  progress: ITunerProgress | null;
  result: ITuneResult | null;
  failure: string | null;
  applied: boolean;
  loadStatus: 'idle' | 'loading' | 'error';
}

export function makeInitialState(): ITunerState {
  return {
    connection: 'disconnected',
    activeGameId: null,
    seedModelText: '',
    params: null,
    derivedTarget: null,
    targetGap: null,
    status: 'idle',
    progress: null,
    result: null,
    failure: null,
    applied: false,
    loadStatus: 'idle',
  };
}

export const tunerHooks = makePluginHooks<ITunerState>(TUNER_PLUGIN_ID);

export function tunerSlice(): State<ITunerState> {
  return rootStore.plugins.nested(TUNER_PLUGIN_ID) as unknown as State<ITunerState>;
}

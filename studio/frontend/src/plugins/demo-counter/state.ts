import { makePluginHooks } from '../../state/makePluginHooks';

export interface ICounterState { count: number }

export const counterHooks = makePluginHooks<ICounterState>('demo-counter');

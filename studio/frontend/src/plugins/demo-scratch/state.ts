import { makePluginHooks } from '../../state/makePluginHooks';

export interface IScratchState { text: string }

export const scratchHooks = makePluginHooks<IScratchState>('demo-scratch');

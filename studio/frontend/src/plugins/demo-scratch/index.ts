import type { IPlugin } from '../../host/types';
import type { IScratchState } from './state';
import { ScratchPane } from './ScratchPane';

export const demoScratch: IPlugin<IScratchState> = {
  id: 'demo-scratch',
  title: 'Scratch',
  persist: false,
  initialState: { text: '' },
  panes: [
    {
      id: 'demo-scratch/main',
      title: 'Scratch',
      component: ScratchPane as never,
    },
  ],
};

import type { IPlugin } from '../../host/types';
import type { ICounterState } from './state';
import { CounterPane } from './CounterPane';
import { MirrorPane } from './MirrorPane';
import { rootStore } from '../../state/rootStore';
import type { State } from '@hookstate/core';

export const demoCounter: IPlugin<ICounterState> = {
  id: 'demo-counter',
  title: 'Counter',
  persist: true,
  initialState: { count: 0 },
  panes: [
    {
      id: 'demo-counter/editor',
      title: 'Counter',
      component: CounterPane as never,
    },
    {
      id: 'demo-counter/mirror',
      title: 'Mirror',
      component: MirrorPane as never,
    },
  ],
  commands: [
    {
      id: 'demo-counter/increment',
      title: 'Increment Counter',
      run: () => {
        const slice = rootStore.plugins.nested('demo-counter') as unknown as State<ICounterState>;
        slice.count.set((c) => c + 1);
      },
    },
  ],
};

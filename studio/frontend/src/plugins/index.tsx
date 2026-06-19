// Temporary one-pane plugin — replaced in Task 13 with the real plugin suite.
import type { IPlugin } from '../host/types';

const TempPane = () => <div data-testid="temp-pane">temp</div>;

export const PLUGINS: IPlugin[] = [
  {
    id: 'temp',
    title: 'Temp',
    panes: [{ id: 'temp/main', title: 'Temp', component: TempPane as never }],
  },
];

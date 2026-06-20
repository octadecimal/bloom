import type { DockviewApi } from 'dockview-react';

export function DEFAULT_LAYOUT(api: DockviewApi, paneRegistry: { get(id: string): { title?: string } | undefined }): void {
  const add = (id: string, ref?: { direction: 'right' | 'below'; referencePanel: string }) => {
    if (!api.getPanel(id))
      api.addPanel({
        id,
        component: id,
        title: paneRegistry.get(id)?.title ?? id,
        params: { paneId: id },
        position: ref,
      });
  };
  add('llm-chat/room');
  add('llm-chat/settings', { direction: 'right', referencePanel: 'llm-chat/room' });
  add('assets/board', { direction: 'below', referencePanel: 'llm-chat/room' });
}

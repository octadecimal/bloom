import type { DockviewApi } from 'dockview-react';

interface IPaneRegistryLikeLocal {
  get(id: string): { title?: string } | undefined;
}

// Mirrors the DEFAULT_LAYOUT add idiom; kept separate so Reset's default and
// the preset built-ins stay decoupled.
function addPane(
  api: DockviewApi,
  reg: IPaneRegistryLikeLocal,
  id: string,
  position?: { direction: 'right' | 'below'; referencePanel: string },
): void {
  if (!api.getPanel(id)) {
    api.addPanel({ id, component: id, title: reg.get(id)?.title ?? id, params: { paneId: id }, position });
  }
}

export const LAYOUT_BUILTINS: Record<string, (api: DockviewApi, reg: IPaneRegistryLikeLocal) => void> = {
  Chat(api, reg) {
    addPane(api, reg, 'llm-chat/room');
    addPane(api, reg, 'llm-chat/settings', { direction: 'right', referencePanel: 'llm-chat/room' });
  },
  Focus(api, reg) {
    addPane(api, reg, 'llm-chat/room');
  },
};

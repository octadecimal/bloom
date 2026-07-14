import type { DockviewApi } from 'dockview-react';

interface IPaneRegistryLikeLocal {
  get(id: string): { title?: string } | undefined;
}

type Position = { direction: 'left' | 'right' | 'below'; referencePanel: string };

// Mirrors the Dockview add idiom; add-if-missing so re-applying a preset over
// a partial layout only fills the gaps.
function addPane(api: DockviewApi, reg: IPaneRegistryLikeLocal, id: string, position?: Position, initialWidth?: number): void {
  if (!api.getPanel(id)) {
    api.addPanel({ id, component: id, title: reg.get(id)?.title ?? id, params: { paneId: id }, position, initialWidth });
  }
}

// The four authoring-journey phases (spec: workbench-ux-pass1). Chat is the
// control surface, docked left in every phase.
export const LAYOUT_BUILTINS: Record<string, (api: DockviewApi, reg: IPaneRegistryLikeLocal) => void> = {
  Design(api, reg) {
    addPane(api, reg, 'llm-chat/room');
    addPane(api, reg, 'gdd/viewer', { direction: 'right', referencePanel: 'llm-chat/room' });
  },
  Art(api, reg) {
    addPane(api, reg, 'llm-chat/room');
    addPane(api, reg, 'game/preview', { direction: 'right', referencePanel: 'llm-chat/room' });
    addPane(api, reg, 'property-inspector/panel', { direction: 'right', referencePanel: 'game/preview' });
    addPane(api, reg, 'assets/board', { direction: 'below', referencePanel: 'game/preview' });
  },
  Math(api, reg) {
    addPane(api, reg, 'llm-chat/room');
    addPane(api, reg, 'game-config/editor', { direction: 'right', referencePanel: 'llm-chat/room' });
    addPane(api, reg, 'math/viewer', { direction: 'right', referencePanel: 'game-config/editor' });
  },
  Play(api, reg) {
    // Game scene first so it owns the dominant share; chat docks left, narrow.
    addPane(api, reg, 'game/preview');
    addPane(api, reg, 'llm-chat/room', { direction: 'left', referencePanel: 'game/preview' }, 360);
  },
};

import type { ComponentType } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { IPaneDef } from './types';
import { PaneErrorBoundary } from '../app/PaneErrorBoundary';

export function createPaneRegistry() {
  const panes = new Map<string, IPaneDef>();
  let cache: Record<string, ComponentType<IDockviewPanelProps>> | null = null;

  return {
    register(def: IPaneDef) {
      panes.set(def.id, def);
      cache = null; // invalidate the memoized map
    },
    get: (id: string) => panes.get(id),
    list: () => [...panes.values()],
    asComponentMap() {
      if (!cache) {
        cache = {};
        for (const [id, def] of panes) {
          const Comp = def.component;
          cache[id] = (props: IDockviewPanelProps) => (
            <PaneErrorBoundary>
              <Comp {...props} />
            </PaneErrorBoundary>
          );
        }
      }
      return cache;
    },
  };
}

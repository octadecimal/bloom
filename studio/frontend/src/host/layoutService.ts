import { loadPersisted, makeDebouncedSaver } from '../state/persistence';

const LAYOUT_KEY = 'layout';
const LAYOUT_VERSION = 1;

// dockview serializes panels under a `panels` map keyed by panel id.
export function panelIdsFromLayout(layout: unknown): string[] {
  const panels = (layout as { panels?: Record<string, unknown> })?.panels;
  return panels ? Object.keys(panels) : [];
}

interface IPaneRegistryLike {
  get(id: string): unknown | undefined;
}

export function createLayoutService(deps: {
  paneRegistry: IPaneRegistryLike;
  defaultLayout: (api: any) => void;
}) {
  const save = makeDebouncedSaver<unknown>(LAYOUT_KEY, LAYOUT_VERSION);

  function restore(api: any): void {
    const saved = loadPersisted<unknown | null>(LAYOUT_KEY, LAYOUT_VERSION, null);
    if (saved == null) return deps.defaultLayout(api);
    const ids = panelIdsFromLayout(saved);
    const unknown = ids.filter((id) => !deps.paneRegistry.get(id));
    if (unknown.length > 0) {
      console.warn('[layout] dropping unknown panels, using default:', unknown);
      return deps.defaultLayout(api);
    }
    api.fromJSON(saved);
  }

  return {
    attach(api: any) {
      restore(api);
      api.onDidLayoutChange(() => save(api.toJSON()));
    },
    reset() {
      save(null);
    },
  };
}

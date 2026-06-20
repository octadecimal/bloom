import { panelIdsFromLayout } from './layoutService';
import { savePersisted, loadPersisted } from '../state/persistence';

const LAYOUT_PRESETS_KEY = 'layoutPresets';
const LAYOUT_PRESETS_VERSION = 1;

export interface ILayoutPresetInfo {
  name: string;
  kind: 'builtin' | 'user';
}

export interface IPaneRegistryLike {
  get(id: string): { title?: string } | undefined;
}

export interface ILayoutBuilder {
  (api: any, paneRegistry: IPaneRegistryLike): void;
}

export interface ILayoutPresetsDeps {
  getApi: () => any | null;
  paneRegistry: IPaneRegistryLike;
  builtins: Record<string, ILayoutBuilder>;
  notify: { error(msg: string): void };
}

export interface ILayoutPresetsService {
  saveAs(name: string): boolean;
  apply(name: string): boolean;
  list(): ILayoutPresetInfo[];
  delete(name: string): void;
  /** Subscribe to preset-list changes (save or delete). Returns an unsubscribe function. */
  onPresetsChange(cb: () => void): () => void;
}

type UserMap = Record<string, unknown>;

export function createLayoutPresetsService(deps: ILayoutPresetsDeps): ILayoutPresetsService {
  const loadUser = (): UserMap => loadPersisted<UserMap>(LAYOUT_PRESETS_KEY, LAYOUT_PRESETS_VERSION, {});
  const saveUser = (map: UserMap): void => savePersisted(LAYOUT_PRESETS_KEY, LAYOUT_PRESETS_VERSION, map);
  const changeListeners = new Set<() => void>();
  const notifyChange = () => changeListeners.forEach((cb) => cb());

  function saveAs(name: string): boolean {
    const trimmed = name.trim();
    if (!trimmed) {
      deps.notify.error('Enter a name for the arrangement.');
      return false;
    }
    if (deps.builtins[trimmed]) {
      deps.notify.error(`"${trimmed}" is a built-in arrangement and can't be overwritten.`);
      return false;
    }
    const api = deps.getApi();
    if (!api) return false;
    const map = loadUser();
    map[trimmed] = api.toJSON();
    saveUser(map);
    notifyChange();
    return true;
  }

  function apply(name: string): boolean {
    const api = deps.getApi();
    if (!api) return false;
    const builtin = deps.builtins[name];
    if (builtin) {
      api.clear();
      builtin(api, deps.paneRegistry);
      return true;
    }
    const layout = loadUser()[name];
    if (layout == null) {
      deps.notify.error(`No arrangement named "${name}".`);
      return false;
    }
    const unknown = panelIdsFromLayout(layout).filter((id) => !deps.paneRegistry.get(id));
    if (unknown.length > 0) {
      console.warn('[layout] refusing preset with unknown panes:', unknown);
      deps.notify.error(`Arrangement "${name}" references panes that no longer exist.`);
      return false;
    }
    api.fromJSON(layout);
    return true;
  }

  function list(): ILayoutPresetInfo[] {
    const builtins: ILayoutPresetInfo[] = Object.keys(deps.builtins).map((name) => ({ name, kind: 'builtin' }));
    const users: ILayoutPresetInfo[] = Object.keys(loadUser())
      .sort()
      .map((name) => ({ name, kind: 'user' }));
    return [...builtins, ...users];
  }

  function remove(name: string): void {
    const map = loadUser();
    if (!(name in map)) return;
    delete map[name];
    saveUser(map);
    notifyChange();
  }

  function onPresetsChange(cb: () => void): () => void {
    changeListeners.add(cb);
    return () => {
      changeListeners.delete(cb);
    };
  }

  return { saveAs, apply, list, delete: remove, onPresetsChange };
}

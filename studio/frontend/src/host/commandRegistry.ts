import type { ICommandDef } from './types';

export function createCommandRegistry() {
  const cmds = new Map<string, ICommandDef>();
  return {
    register: (def: ICommandDef) => void cmds.set(def.id, def),
    get: (id: string) => cmds.get(id),
    list: () => [...cmds.values()],
  };
}

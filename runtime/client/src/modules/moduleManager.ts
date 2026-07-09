import type { IGameModule, IModuleHost } from './module';
import type { ModuleRegistry } from './registry';
import type { IModuleDecl } from '../model/document';

/** Owns the live module instances declared on the scene document. On sync it
 *  disposes the previous set and rebuilds from the declarations, projecting +
 *  mounting each — the structure plane is a deterministic function of the
 *  declaration (cells are derived client-side, never round-tripped upstream). */
export class ModuleManager {
  private modules = new Map<string, IGameModule>();

  constructor(private readonly deps: { registry: ModuleRegistry; host: IModuleHost }) {}

  sync(decls: IModuleDecl[]): void {
    for (const m of this.modules.values()) m.dispose();
    this.modules.clear();
    for (const d of decls) {
      if (!this.deps.registry.has(d.type)) continue;
      const m = this.deps.registry.create(d.type, { id: d.id, host: this.deps.host, config: d.config });
      this.modules.set(d.id, m);
      m.project();
      m.mount();
    }
  }

  byType(type: string): IGameModule | undefined {
    for (const m of this.modules.values()) if (m.type === type) return m;
    return undefined;
  }

  /** Instance lookup by declaration id — the TraceWalker resolves mechanic
   *  instance ids (e.g. 'main_reels') through this. */
  byId(id: string): IGameModule | undefined {
    return this.modules.get(id);
  }
}

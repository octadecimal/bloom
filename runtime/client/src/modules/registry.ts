import type { IGameModule, IModuleFactory, IModuleHost } from './module';
import type { JsonValue } from '../model/document';

/** Maps `type → IGameModule` factory. The surface a future server tier mirrors for parity (spec §3). */
export class ModuleRegistry {
  private factories = new Map<string, IModuleFactory>();

  register(type: string, factory: IModuleFactory): void {
    if (this.factories.has(type)) throw new Error(`module type already registered: ${type}`);
    this.factories.set(type, factory);
  }

  has(type: string): boolean {
    return this.factories.has(type);
  }

  create(type: string, args: { id: string; host: IModuleHost; config?: Record<string, JsonValue> }): IGameModule {
    const factory = this.factories.get(type);
    if (!factory) throw new Error(`unknown module type: ${type}`);
    return factory(args);
  }
}

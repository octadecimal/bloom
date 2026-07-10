import { GraphModel } from './model/graphModel';
import { Reconciler } from './render/reconciler';
import type { IRenderer } from './render/renderer';
import { ProtocolHost } from './protocol/protocolHost';
import type { OutboundMessage } from './protocol/messages';
import { createBus, type IEventBus } from './orchestration/bus';
import { createModuleHost } from './modules/host';
import { ModuleRegistry } from './modules/registry';
import { ModuleManager } from './modules/moduleManager';
import { Orchestrator, type IReelsControl } from './orchestration/orchestrator';
import { ReelsModule } from './modules/reels/reelsModule';
import { MeterModule } from './modules/meter/meterModule';
import { ViewportController, type IHostSurface } from './render/viewportController';
import { TraceWalker, type ITriggerTarget } from './orchestration/traceWalker';

export interface IEngineModules {
  registry: ModuleRegistry;
  manager: ModuleManager;
  orchestrator: Orchestrator;
  bus: IEventBus;
}

export function createEngine(deps: { renderer: IRenderer; post: (m: OutboundMessage) => void; surface?: IHostSurface }): {
  host: ProtocolHost;
  model: GraphModel;
  modules: IEngineModules;
  viewport?: ViewportController;
} {
  const model = new GraphModel();
  const bus = createBus();
  const viewport = deps.surface ? new ViewportController({ surface: deps.surface, renderer: deps.renderer, bus }) : undefined;
  const reconciler = new Reconciler(deps.renderer, model, viewport);
  const moduleHost = createModuleHost({ model, reconciler, renderer: deps.renderer, bus });

  const registry = new ModuleRegistry();
  registry.register('reels', (args) => new ReelsModule(args));
  registry.register('meter', (args) => new MeterModule(args));
  const manager = new ModuleManager({ registry, host: moduleHost });

  const orchestrator = new Orchestrator({
    bus,
    reels: () => (manager.byType('reels') as unknown as IReelsControl) ?? null,
  });
  const walker = new TraceWalker({
    bus,
    resolve: (id) => {
      const m = manager.byId(id) as unknown as Partial<ITriggerTarget> | undefined;
      return m && typeof m.invoke === 'function' ? (m as ITriggerTarget) : null;
    },
  });
  const host = new ProtocolHost({
    model,
    reconciler,
    post: deps.post,
    onSpin: (o) => orchestrator.spin(o),
    onTrace: (entries) => walker.walk(entries),
    onModules: (decls) => manager.sync(decls),
  });

  return { host, model, modules: { registry, manager, orchestrator, bus }, viewport };
}

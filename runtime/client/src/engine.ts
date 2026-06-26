import { GraphModel } from './model/graphModel';
import { Reconciler } from './render/reconciler';
import type { IRenderer } from './render/renderer';
import { ProtocolHost } from './protocol/protocolHost';
import type { OutboundMessage } from './protocol/messages';
import { createBus, type IEventBus } from './orchestration/bus';
import { createModuleHost } from './modules/host';
import { ModuleRegistry } from './modules/registry';
import { Orchestrator } from './orchestration/orchestrator';
import { ReelsModule } from './modules/reels/reelsModule';
import { ViewportController, type IHostSurface } from './render/viewportController';

export interface IEngineModules {
  registry: ModuleRegistry;
  orchestrator: Orchestrator;
  reels: ReelsModule;
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
  const reels = registry.create('reels', { id: 'reels', host: moduleHost, config: { parentId: 'root' } }) as ReelsModule;
  reels.mount();

  const orchestrator = new Orchestrator({ bus, reels });
  const host = new ProtocolHost({ model, reconciler, post: deps.post, onSpin: (o) => orchestrator.spin(o) });

  return { host, model, modules: { registry, orchestrator, reels, bus }, viewport };
}

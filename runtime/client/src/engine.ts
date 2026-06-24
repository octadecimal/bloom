import { GraphModel } from './model/graphModel';
import { Reconciler } from './render/reconciler';
import type { IRenderer } from './render/renderer';
import { ProtocolHost } from './protocol/protocolHost';
import type { OutboundMessage } from './protocol/messages';

export function createEngine(deps: { renderer: IRenderer; post: (m: OutboundMessage) => void }): {
  host: ProtocolHost;
  model: GraphModel;
} {
  const model = new GraphModel();
  const reconciler = new Reconciler(deps.renderer, model);
  const host = new ProtocolHost({ model, reconciler, post: deps.post });
  return { host, model };
}

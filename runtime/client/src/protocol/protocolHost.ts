import { emptyDocument } from '../model/document';
import { OpError } from '../model/ops';
import type { GraphModel } from '../model/graphModel';
import type { Reconciler } from '../render/reconciler';
import type { IOutcome } from '../modules/module';
import { PROTOCOL_VERSION, type InboundMessage, type OutboundMessage } from './messages';

export interface IProtocolDeps {
  model: GraphModel;
  reconciler: Reconciler;
  post: (msg: OutboundMessage) => void;
  onSpin?: (outcome: IOutcome) => void;
}

export class ProtocolHost {
  constructor(private readonly deps: IProtocolDeps) {}

  start(): void {
    this.deps.post({ v: 1, kind: 'ready', protocolVersion: PROTOCOL_VERSION });
  }

  async handle(msg: InboundMessage): Promise<void> {
    if (!msg || msg.v !== PROTOCOL_VERSION || typeof msg.kind !== 'string') return;
    try {
      if (msg.kind === 'init') {
        const changes = this.deps.model.load(msg.document ?? emptyDocument());
        await this.deps.reconciler.applyChanges(changes);
      } else if (msg.kind === 'op') {
        const changes = this.deps.model.apply(msg.op);
        await this.deps.reconciler.applyChanges(changes);
      } else if (msg.kind === 'batch') {
        const changes = this.deps.model.applyBatch(msg.ops);
        await this.deps.reconciler.applyChanges(changes);
      } else if (msg.kind === 'spin') {
        this.deps.onSpin?.(msg.outcome);
      } else if (msg.kind === 'capture') {
        const png = await this.deps.reconciler.capture();
        this.deps.post({ v: 1, kind: 'captured', id: msg.id, png });
        return; // capture replies with `captured`, not the generic `ack`
      } else {
        return;
      }
      this.deps.post({ v: 1, kind: 'ack', id: msg.id });
    } catch (err) {
      const code = err instanceof OpError ? err.code : 'internal';
      const message = err instanceof Error ? err.message : String(err);
      this.deps.post({ v: 1, kind: 'error', id: msg.id, code, message });
    }
  }
}

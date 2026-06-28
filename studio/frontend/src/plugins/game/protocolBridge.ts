import type { ISceneDocument } from '../../scene/types';
import type { ISceneOp } from '../../scene/reducers';

type InboundMessage =
  | { v: 1; kind: 'init'; id: string; document?: ISceneDocument }
  | { v: 1; kind: 'op'; id: string; op: ISceneOp }
  | { v: 1; kind: 'batch'; id: string; ops: ISceneOp[] }
  | { v: 1; kind: 'spin'; id: string; outcome: { grid: string[][] } }
  | { v: 1; kind: 'capture'; id: string };

type OutboundMessage =
  | { v: 1; kind: 'ready'; protocolVersion: 1 }
  | { v: 1; kind: 'ack'; id: string }
  | { v: 1; kind: 'captured'; id: string; png: string }
  | { v: 1; kind: 'error'; id: string; code: string; message: string };

export interface IProtocolBridgeDeps {
  post: (m: InboundMessage, targetOrigin: string) => void;
  engineOrigin: string;
  onError?: (e: { code: string; message: string }) => void;
  onCaptured?: (c: { id: string; png: string }) => void;
}

export class ProtocolBridge {
  private ready = false;
  private queue: InboundMessage[] = [];
  private seq = 0;

  constructor(private readonly deps: IProtocolBridgeDeps) {}

  handleEngineMessage(data: OutboundMessage, origin: string): void {
    if (origin !== this.deps.engineOrigin) return;
    if (!data || data.v !== 1) return;
    if (data.kind === 'ready') {
      this.ready = true;
      const pending = this.queue;
      this.queue = [];
      for (const m of pending) this.deps.post(m, this.deps.engineOrigin);
    } else if (data.kind === 'error') {
      this.deps.onError?.({ code: data.code, message: data.message });
    } else if (data.kind === 'captured') {
      this.deps.onCaptured?.({ id: data.id, png: data.png });
    }
  }

  init(document: ISceneDocument): void {
    this.send({ v: 1, kind: 'init', id: this.nextId(), document });
  }

  op(op: ISceneOp): void {
    this.send({ v: 1, kind: 'op', id: this.nextId(), op });
  }

  batch(ops: ISceneOp[]): void {
    this.send({ v: 1, kind: 'batch', id: this.nextId(), ops });
  }

  /** Drive a spin round: the engine settles the reels onto `outcome.grid`. */
  spin(outcome: { grid: string[][] }): void {
    this.send({ v: 1, kind: 'spin', id: this.nextId(), outcome });
  }

  /** Request a render-settled frame capture. The engine replies with `captured`,
   *  surfaced via deps.onCaptured. `id` is the backend-issued captureId so the
   *  PNG can be correlated when relayed back over the socket. */
  capture(id: string): void {
    this.send({ v: 1, kind: 'capture', id });
  }

  reset(): void {
    this.ready = false;
    this.queue = [];
  }

  private send(m: InboundMessage): void {
    if (!this.ready) this.queue.push(m);
    else this.deps.post(m, this.deps.engineOrigin);
  }

  private nextId(): string {
    return `m${++this.seq}`;
  }
}

// Module singleton so the socket client can reach the pane's live bridge.
let active: ProtocolBridge | null = null;
export function setBridge(b: ProtocolBridge): void {
  active = b;
}
export function getBridge(): ProtocolBridge | null {
  return active;
}
export function clearBridge(b: ProtocolBridge): void {
  if (active === b) active = null;
}

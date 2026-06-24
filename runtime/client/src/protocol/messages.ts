import type { IGameDocument } from '../model/document';
import type { Op } from '../model/ops';

export const PROTOCOL_VERSION = 1 as const;

export type InboundMessage =
  | { v: 1; kind: 'init'; id: string; document?: IGameDocument }
  | { v: 1; kind: 'op'; id: string; op: Op }
  | { v: 1; kind: 'batch'; id: string; ops: Op[] };

export type OutboundMessage =
  | { v: 1; kind: 'ready'; protocolVersion: 1 }
  | { v: 1; kind: 'ack'; id: string }
  | { v: 1; kind: 'error'; id: string; code: string; message: string };

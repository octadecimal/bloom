import { describe, expect, it, vi } from 'vitest';
import { ProtocolHost } from './protocolHost';
import type { ITraceEntry } from '../play/composedTypes';

// Reuse the minimal fakes from protocolHost.spin.spec.ts (model/reconciler/post) —
// copy its makeDeps helper shape.

describe('trace message', () => {
  it('dispatches entries to onTrace, awaits it, then acks', async () => {
    const posted: unknown[] = [];
    const order: string[] = [];
    const onTrace = vi.fn(async (entries: ITraceEntry[]) => {
      order.push(`walk:${entries.length}`);
    });
    const host = new ProtocolHost({
      model: { load: () => [], apply: () => [], applyBatch: () => [] } as never,
      reconciler: { applyChanges: async () => {}, capture: async () => '' } as never,
      post: (m) => {
        posted.push(m);
        order.push((m as { kind: string }).kind);
      },
      onTrace,
    });
    await host.handle({ v: 1, kind: 'trace', id: 't1', entries: [{ t: 'round_end', total_payout: 5 }] });
    expect(onTrace).toHaveBeenCalledOnce();
    expect(order).toEqual(['walk:1', 'ack']);
    expect(posted.at(-1)).toEqual({ v: 1, kind: 'ack', id: 't1' });
  });

  it('a throwing walk posts a protocol error, not an unhandled rejection', async () => {
    const posted: Array<{ kind: string }> = [];
    const host = new ProtocolHost({
      model: { load: () => [], apply: () => [], applyBatch: () => [] } as never,
      reconciler: { applyChanges: async () => {}, capture: async () => '' } as never,
      post: (m) => posted.push(m as { kind: string }),
      onTrace: async () => {
        throw new Error('no module for mechanic: ghost');
      },
    });
    await host.handle({ v: 1, kind: 'trace', id: 't2', entries: [] });
    expect(posted.at(-1)?.kind).toBe('error');
  });
});

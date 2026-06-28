import { describe, it, expect } from 'vitest';
import { MockRenderer } from './render/mockRenderer';
import { createEngine } from './engine';

const DOC_WITH_REELS = {
  version: 1 as const,
  nodes: { root: { id: 'root', type: 'Root' as const, props: {} } },
  edges: [],
  modules: [{ id: 'reels', type: 'reels', config: { parentId: 'root' } }],
};

describe('createEngine modules wiring', () => {
  it('instantiates a declared reels module on init', async () => {
    const { host, modules } = createEngine({ renderer: new MockRenderer(), post: () => {} });
    await host.handle({ v: 1, kind: 'init', id: 'i', document: DOC_WITH_REELS });
    expect(modules.manager.byType('reels')?.type).toBe('reels');
    expect(modules.orchestrator).toBeTruthy();
  });

  it('a spin message drives the declared reels module to settle to the outcome grid', async () => {
    const renderer = new MockRenderer();
    const { host, modules } = createEngine({ renderer, post: () => {} });
    await host.handle({ v: 1, kind: 'init', id: 'i', document: DOC_WITH_REELS });
    await host.handle({ v: 1, kind: 'spin', id: 's', outcome: { grid: [['B'], ['C'], ['A'], ['B'], ['C']] } });
    for (let i = 0; i < 300; i++) renderer.tickCbs.forEach((cb) => cb(16));
    const reels = modules.manager.byType('reels')!;
    expect((reels as unknown as { debugState(): { phase: string } }).debugState().phase).toBe('idle');
    expect((reels as unknown as { debugState(): { grid: string[][] } }).debugState().grid[0]).toEqual(['B']);
  });
});

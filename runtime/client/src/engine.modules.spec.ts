import { describe, it, expect } from 'vitest';
import { MockRenderer } from './render/mockRenderer';
import { createEngine } from './engine';

describe('createEngine modules wiring', () => {
  it('exposes a reels module and an orchestrator', () => {
    const { modules } = createEngine({ renderer: new MockRenderer(), post: () => {} });
    expect(modules.reels.type).toBe('reels');
    expect(modules.orchestrator).toBeTruthy();
  });

  it('a spin message drives the reels module to project + settle to the outcome grid', async () => {
    const renderer = new MockRenderer();
    const { host, modules } = createEngine({ renderer, post: () => {} });
    await host.handle({ v: 1, kind: 'init', id: 'i', document: { version: 1, nodes: { root: { id: 'root', type: 'Root', props: {} } }, edges: [] } });
    await host.handle({ v: 1, kind: 'spin', id: 's', outcome: { grid: [['B'], ['C'], ['A'], ['B'], ['C']] } });
    // Drive the tick manually (MockRenderer records tick callbacks).
    for (let i = 0; i < 300; i++) renderer.tickCbs.forEach((cb) => cb(16));
    expect(modules.reels.debugState().phase).toBe('idle');
    expect(modules.reels.debugState().grid[0]).toEqual(['B']);
  });
});

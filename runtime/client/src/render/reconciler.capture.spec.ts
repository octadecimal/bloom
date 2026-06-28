import { describe, it, expect } from 'vitest';
import { GraphModel } from '../model/graphModel';
import { MockRenderer } from './mockRenderer';
import { Reconciler } from './reconciler';

describe('Reconciler.capture', () => {
  it('delegates to the renderer and returns its png data url', async () => {
    const renderer = new MockRenderer();
    const reconciler = new Reconciler(renderer, new GraphModel());
    expect(await reconciler.capture()).toBe('data:image/png;base64,MOCK');
    expect(renderer.calls).toContainEqual(['capture']);
  });
});

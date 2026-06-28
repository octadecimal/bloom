import { describe, it, expect, vi } from 'vitest';
import { PixiRenderer } from './pixiRenderer';

describe('PixiRenderer.capture', () => {
  it('returns an empty string before mount (no app)', async () => {
    const r = new PixiRenderer(document.createElement('div'));
    expect(await r.capture()).toBe('');
  });

  it('waits one animation frame (render-settled) then extracts the stage as a png data url', async () => {
    const r = new PixiRenderer(document.createElement('div'));
    const stage = { __isStage: true };
    const screen = { x: 0, y: 0, width: 640, height: 480 };
    const base64 = vi.fn(async () => 'data:image/png;base64,AAAA');
    // Inject a fake mounted app — mirrors the private-field injection pattern in
    // pixiRenderer.handle.spec.ts ("buffers ticks ... once the app exists").
    (r as unknown as { app: unknown }).app = { stage, renderer: { extract: { base64 }, screen } };
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame');

    const png = await r.capture();

    expect(raf).toHaveBeenCalledTimes(1); // render-settled barrier
    expect(base64).toHaveBeenCalledWith({ target: stage, frame: screen, clearColor: '#0b0b0c' });
    expect(png).toBe('data:image/png;base64,AAAA');
    raf.mockRestore();
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('PLUGINS demo gating', () => {
  it('includes demo plugins outside prod', async () => {
    vi.resetModules();
    const { PLUGINS } = await import('./index');
    const ids = PLUGINS.map((p) => p.id);
    expect(ids).toContain('demo-counter');
    expect(ids).toContain('demo-scratch');
  });

  it('excludes demo plugins in prod builds', async () => {
    vi.stubEnv('PROD', true);
    vi.resetModules();
    const { PLUGINS } = await import('./index');
    const ids = PLUGINS.map((p) => p.id);
    expect(ids).not.toContain('demo-counter');
    expect(ids).not.toContain('demo-scratch');
  });
});

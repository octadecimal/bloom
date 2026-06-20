// studio/frontend/src/plugins/assets/reducers.spec.ts
import { describe, it, expect } from 'vitest';
import type { IAsset } from './state';
import { upsertAsset, setAssetStatus, setAssetProgress } from './reducers';

const base: IAsset = {
  id: 'a1', gameId: 'g1', name: 'Wild', category: null,
  prompt: 'p', width: 64, height: 64, workflow: 'schnell-transparent',
  seed: null, status: 'idle', generations: [], selectedGenerationId: null,
  error: null, progress: null,
};

describe('assets reducers', () => {
  it('upsertAsset adds then replaces by id', () => {
    const added = upsertAsset([], base);
    expect(added).toHaveLength(1);
    const replaced = upsertAsset(added, { ...base, name: 'Renamed' });
    expect(replaced).toHaveLength(1);
    expect(replaced[0].name).toBe('Renamed');
  });

  it('setAssetStatus updates only the target asset', () => {
    const out = setAssetStatus([base, { ...base, id: 'a2' }], 'a1', 'generating');
    expect(out.find((a) => a.id === 'a1')!.status).toBe('generating');
    expect(out.find((a) => a.id === 'a2')!.status).toBe('idle');
  });

  it('setAssetProgress sets a {value,max} on the target asset', () => {
    const out = setAssetProgress([base], 'a1', 2, 4);
    expect(out[0].progress).toEqual({ value: 2, max: 4 });
  });
});

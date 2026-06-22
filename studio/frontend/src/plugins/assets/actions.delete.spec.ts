import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { ASSETS_PLUGIN_ID, assetsSlice, makeInitialState } from './state';
import * as actions from './actions';

vi.mock('../../lib/notify', () => ({ notify: { error: vi.fn(), info: vi.fn() } }));
import { notify } from '../../lib/notify';

beforeEach(() => {
  rootStore.plugins.nested(ASSETS_PLUGIN_ID).set(makeInitialState() as never);
  vi.clearAllMocks();
});

describe('deleteAsset', () => {
  it('removes the asset from state and shows a confirmation toast', async () => {
    assetsSlice().assets.set([{ id: 'a1' } as never]);
    actions.__setDeps({
      rest: {
        getAssets: vi.fn(),
        createAsset: vi.fn(),
        updateAsset: vi.fn(),
        deleteAsset: vi.fn().mockResolvedValue(undefined),
        selectGeneration: vi.fn(),
      },
    });

    await actions.deleteAsset('a1');

    expect(assetsSlice().assets.get({ noproxy: true })).toHaveLength(0);
    expect(notify.info).toHaveBeenCalledWith('Asset deleted');
  });
});

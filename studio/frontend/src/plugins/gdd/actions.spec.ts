import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { GDD_PLUGIN_ID, gddSlice, makeInitialState, type IGddDoc } from './state';
import * as rest from './restClient';
import { saveIntentFields } from './actions';

const doc = (aspect: string, data: Record<string, unknown>): IGddDoc => ({
  id: aspect,
  gameId: 'g1',
  aspect,
  title: aspect,
  order: 6,
  body: '',
  status: 'drafted',
  data,
  createdAt: '',
  updatedAt: '',
});

beforeEach(() => rootStore.plugins.nested(GDD_PLUGIN_ID).set(makeInitialState() as never));
afterEach(() => vi.restoreAllMocks());

describe('saveIntentFields', () => {
  it('PUTs and upserts the returned doc into state', async () => {
    gddSlice().activeGameId.set('g1');
    gddSlice().docs.set([doc('ui-ux', { orientation: 'landscape' })]);
    vi.spyOn(rest, 'setGddFields').mockResolvedValue({
      doc: doc('ui-ux', { orientation: 'portrait' }),
      warnings: [],
      rebuilt: true,
    });

    const res = await saveIntentFields('g1', 'ui-ux', { orientation: 'portrait' });
    expect(res.rebuilt).toBe(true);
    const updated = gddSlice()
      .docs.get({ noproxy: true })
      .find((d) => d.aspect === 'ui-ux');
    expect(updated?.data.orientation).toBe('portrait');
  });
});

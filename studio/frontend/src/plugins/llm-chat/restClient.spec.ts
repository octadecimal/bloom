import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getModels, getRooms, createRoom, getMessages, getSkills } from './restClient';
import { BACKEND_URL } from './config';

function mockFetch(json: unknown, status = 200) {
  return vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => json } as Response);
}

describe('restClient', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('getModels GETs /models', async () => {
    const fetchMock = mockFetch([{ id: 'm', label: 'M', free: true }]);
    vi.stubGlobal('fetch', fetchMock);
    const out = await getModels();
    expect(fetchMock).toHaveBeenCalledWith(`${BACKEND_URL}/models`);
    expect(out).toEqual([{ id: 'm', label: 'M', free: true }]);
  });

  it('getRooms GETs /rooms', async () => {
    const fetchMock = mockFetch([]);
    vi.stubGlobal('fetch', fetchMock);
    await getRooms();
    expect(fetchMock).toHaveBeenCalledWith(`${BACKEND_URL}/rooms`);
  });

  it('createRoom POSTs name + model as JSON', async () => {
    const room = { id: 'r1', name: 'General', model: 'm', gameId: null, createdAt: 't' };
    const fetchMock = mockFetch(room, 201);
    vi.stubGlobal('fetch', fetchMock);
    const out = await createRoom('General', 'm');
    expect(fetchMock).toHaveBeenCalledWith(`${BACKEND_URL}/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'General', model: 'm' }),
    });
    expect(out).toEqual(room);
  });

  it('getMessages GETs /rooms/:id/messages', async () => {
    const fetchMock = mockFetch([]);
    vi.stubGlobal('fetch', fetchMock);
    await getMessages('r1');
    expect(fetchMock).toHaveBeenCalledWith(`${BACKEND_URL}/rooms/r1/messages`);
  });

  it('throws on non-ok response', async () => {
    vi.stubGlobal('fetch', mockFetch({ detail: 'nope' }, 500));
    await expect(getRooms()).rejects.toThrow();
  });

  it('getSkills GETs /skills', async () => {
    const fetchMock = mockFetch([{ name: 'generate-sprite', description: 'd', args: [] }]);
    vi.stubGlobal('fetch', fetchMock);
    const out = await getSkills();
    expect(fetchMock).toHaveBeenCalledWith(`${BACKEND_URL}/skills`);
    expect(out[0].name).toBe('generate-sprite');
  });
});

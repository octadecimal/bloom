import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const getRooms = vi.fn();
const createRoom = vi.fn();
vi.mock('../../plugins/llm-chat/restClient', () => ({
  getRooms: () => getRooms(),
  createRoom: (n: string) => createRoom(n),
}));
vi.mock('../../lib/notify', () => ({ notify: { error: vi.fn(), info: vi.fn() } }));

import { RoomPicker } from './RoomPicker';

beforeEach(() => {
  getRooms.mockReset();
  createRoom.mockReset();
});

function tree() {
  return (
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<RoomPicker />} />
        <Route path="/room/:roomId" element={<div>ROOM</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('RoomPicker', () => {
  it('lists rooms', async () => {
    getRooms.mockResolvedValue([{ id: 'r1', name: 'Alpha', model: 'm', gameId: null, createdAt: 't' }]);
    render(tree());
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
  });
  it('creates + navigates', async () => {
    getRooms.mockResolvedValue([]);
    createRoom.mockResolvedValue({ id: 'r-new', name: 'Beta', model: 'm', gameId: null, createdAt: 't' });
    render(tree());
    await waitFor(() => expect(getRooms).toHaveBeenCalled());
    await userEvent.type(screen.getByPlaceholderText(/new room/i), 'Beta');
    await userEvent.click(screen.getByRole('button', { name: /create/i }));
    expect(await screen.findByText('ROOM')).toBeInTheDocument();
  });
  it('clears the input after a successful create', async () => {
    getRooms.mockResolvedValue([]);
    createRoom.mockResolvedValue({ id: 'r-new', name: 'Beta', model: 'm', gameId: null, createdAt: 't' });
    render(tree());
    await waitFor(() => expect(getRooms).toHaveBeenCalled());
    const input = screen.getByPlaceholderText(/new room/i);
    await userEvent.type(input, 'Beta');
    expect(input).toHaveValue('Beta');
    await userEvent.click(screen.getByRole('button', { name: /create/i }));
    await screen.findByText('ROOM');
    expect(input).toHaveValue('');
  });
  it('shows retry on error', async () => {
    getRooms.mockRejectedValue(new Error('down'));
    render(tree());
    expect(await screen.findByText(/couldn.t load rooms/i)).toBeInTheDocument();
  });
  it('shows a toast on successful create', async () => {
    getRooms.mockResolvedValue([]);
    createRoom.mockResolvedValue({ id: 'r-new', name: 'Beta', model: 'm', gameId: null, createdAt: 't' });
    const { notify } = await import('../../lib/notify');
    render(tree());
    await waitFor(() => expect(getRooms).toHaveBeenCalled());
    await userEvent.type(screen.getByPlaceholderText(/new room/i), 'Beta');
    await userEvent.click(screen.getByRole('button', { name: /create/i }));
    await screen.findByText('ROOM');
    expect(notify.info).toHaveBeenCalledWith('Room created');
  });
});

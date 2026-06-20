import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const getRooms = vi.fn();
const openRoom = vi.fn();
const closeRoom = vi.fn();
const error = vi.fn();
vi.mock('../../plugins/llm-chat/restClient', () => ({ getRooms: () => getRooms() }));
vi.mock('../../plugins/llm-chat/actions', () => ({ openRoom: (id: string) => openRoom(id), closeRoom: () => closeRoom() }));
vi.mock('../../lib/notify', () => ({ notify: { error: (m: string) => error(m), info: vi.fn() } }));
vi.mock('../Workbench', () => ({ Workbench: () => <div data-testid="workbench">WB</div> }));

import { RoomRoute } from './RoomRoute';
import { useActiveRoomId } from './activeRoom';

beforeEach(() => {
  getRooms.mockReset();
  openRoom.mockReset();
  closeRoom.mockReset();
  error.mockReset();
});

function Echo() {
  return <span data-testid="rid">{useActiveRoomId()}</span>;
}
function tree(initial: string) {
  return (
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/" element={<div>PICKER</div>} />
        <Route path="/room/:roomId" element={<RoomRoute><Echo /></RoomRoute>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('RoomRoute', () => {
  it('valid room → workbench + openRoom + context', async () => {
    getRooms.mockResolvedValue([{ id: 'r1', name: 'A', model: 'm', gameId: null, createdAt: 't' }]);
    render(tree('/room/r1'));
    expect(await screen.findByTestId('workbench')).toBeInTheDocument();
    expect(openRoom).toHaveBeenCalledWith('r1');
    expect(screen.getByTestId('rid')).toHaveTextContent('r1');
  });
  it('unknown room → picker + toast', async () => {
    getRooms.mockResolvedValue([{ id: 'r1', name: 'A', model: 'm', gameId: null, createdAt: 't' }]);
    render(tree('/room/nope'));
    expect(await screen.findByText('PICKER')).toBeInTheDocument();
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/no longer exists/i));
  });
});

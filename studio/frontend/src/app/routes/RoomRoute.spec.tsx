import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const getRooms = vi.fn();
const openRoom = vi.fn();
const closeRoom = vi.fn();
const openGame = vi.fn();
const closeGame = vi.fn();
const openGameDocs = vi.fn();
const closeGameDocs = vi.fn();
const error = vi.fn();
vi.mock('../../plugins/llm-chat/restClient', () => ({ getRooms: () => getRooms() }));
vi.mock('../../plugins/llm-chat/actions', () => ({ openRoom: (id: string) => openRoom(id), closeRoom: () => closeRoom() }));
vi.mock('../../plugins/assets/actions', () => ({
  openGame: (id: string) => openGame(id),
  closeGame: () => closeGame(),
}));
vi.mock('../../plugins/gdd/actions', () => ({
  openGameDocs: (id: string) => openGameDocs(id),
  closeGameDocs: () => closeGameDocs(),
}));
vi.mock('../../lib/notify', () => ({ notify: { error: (m: string) => error(m), info: vi.fn() } }));
vi.mock('../Workbench', () => ({
  Workbench: ({ roomContext }: { roomContext?: React.ReactNode }) => <div data-testid="workbench">{roomContext}WB</div>,
}));

import { RoomRoute } from './RoomRoute';
import { useActiveRoomId } from './activeRoom';

beforeEach(() => {
  getRooms.mockReset();
  openRoom.mockReset();
  closeRoom.mockReset();
  openGame.mockReset();
  closeGame.mockReset();
  openGameDocs.mockReset();
  closeGameDocs.mockReset();
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
        <Route
          path="/room/:roomId"
          element={
            <RoomRoute>
              <Echo />
            </RoomRoute>
          }
        />
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
  it('valid room → renders a back-to-rooms link pointing at /', async () => {
    getRooms.mockResolvedValue([{ id: 'r1', name: 'A', model: 'm', gameId: null, createdAt: 't' }]);
    render(tree('/room/r1'));
    const back = await screen.findByRole('link', { name: /rooms/i });
    expect(back).toHaveAttribute('href', '/');
  });
  it('unknown room → picker + toast', async () => {
    getRooms.mockResolvedValue([{ id: 'r1', name: 'A', model: 'm', gameId: null, createdAt: 't' }]);
    render(tree('/room/nope'));
    expect(await screen.findByText('PICKER')).toBeInTheDocument();
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/no longer exists/i));
  });

  it('valid room with a gameId → opens that game', async () => {
    getRooms.mockResolvedValue([{ id: 'r1', name: 'A', model: 'm', gameId: 'g1', createdAt: 't' }]);
    render(tree('/room/r1'));
    expect(await screen.findByTestId('workbench')).toBeInTheDocument();
    expect(openGame).toHaveBeenCalledWith('g1');
  });

  it('valid room without a gameId → openGame is NOT called', async () => {
    getRooms.mockResolvedValue([{ id: 'r1', name: 'A', model: 'm', gameId: null, createdAt: 't' }]);
    render(tree('/room/r1'));
    expect(await screen.findByTestId('workbench')).toBeInTheDocument();
    expect(openGame).not.toHaveBeenCalled();
  });

  it('unmount → closeGame is called', async () => {
    getRooms.mockResolvedValue([{ id: 'r1', name: 'A', model: 'm', gameId: 'g1', createdAt: 't' }]);
    const { unmount } = render(tree('/room/r1'));
    await screen.findByTestId('workbench');
    unmount();
    expect(closeGame).toHaveBeenCalled();
  });
});

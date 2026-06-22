import { useEffect, useState, type ReactNode } from 'react';
import { useParams, Navigate, Link } from 'react-router-dom';
import { getRooms } from '../../plugins/llm-chat/restClient';
import { openRoom, closeRoom } from '../../plugins/llm-chat/actions';
import { openGame, closeGame } from '../../plugins/assets/actions';
import { notify } from '../../lib/notify';
import { ActiveRoomProvider } from './activeRoom';
import { Workbench } from '../Workbench';

type Validation = 'checking' | 'valid' | 'invalid';

export function RoomRoute({ children }: { children?: ReactNode }) {
  const { roomId } = useParams<{ roomId: string }>();
  const [state, setState] = useState<Validation>('checking');

  useEffect(() => {
    let alive = true;
    setState('checking');
    getRooms()
      .then((rooms) => {
        if (!alive) return;
        const room = rooms.find((r) => r.id === roomId);
        if (room) {
          void openRoom(roomId!);
          if (room.gameId) void openGame(room.gameId);
          setState('valid');
        } else {
          setState('invalid');
        }
      })
      .catch(() => alive && setState('invalid'));
    return () => {
      alive = false;
    };
  }, [roomId]);

  // Leave the room AND its game when the route unmounts (back to picker / different room).
  useEffect(
    () => () => {
      closeRoom();
      closeGame();
    },
    [],
  );

  useEffect(() => {
    if (state === 'invalid') notify.error('That room no longer exists.');
  }, [state]);

  if (state === 'checking') return <div data-testid="room-loading">Opening room…</div>;
  if (state === 'invalid' || !roomId) return <Navigate to="/" replace />;
  return (
    <ActiveRoomProvider roomId={roomId}>
      <Workbench
        leading={
          <Link to="/" title="Back to rooms">
            ← Rooms
          </Link>
        }
      />
      {children}
    </ActiveRoomProvider>
  );
}

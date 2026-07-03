import { useEffect, useState, type ReactNode } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { getRooms } from '../../plugins/llm-chat/restClient';
import type { IRoom } from '../../plugins/llm-chat/state';
import { openRoom, closeRoom } from '../../plugins/llm-chat/actions';
import { openGame as openAssetsGame, closeGame as closeAssetsGame } from '../../plugins/assets/actions';
import { openGameDocs, closeGameDocs } from '../../plugins/gdd/actions';
import { openGame, closeGame } from '../../plugins/game/actions';
import { openGameSim, closeGameSim } from '../../plugins/simulator/actions';
import { openGameTuner, closeGameTuner } from '../../plugins/tuner/actions';
import { openGameConfig, closeGameConfig } from '../../plugins/game-config/actions';
import { openGameAnalytics, closeGameAnalytics } from '../../plugins/math-analytics/actions';
import { notify } from '../../lib/notify';
import { ActiveRoomProvider } from './activeRoom';
import { Workbench } from '../Workbench';
import { RoomContext } from '../RoomContext';

type Validation = 'checking' | 'valid' | 'invalid';

export function RoomRoute({ children }: { children?: ReactNode }) {
  const { roomId } = useParams<{ roomId: string }>();
  const [state, setState] = useState<Validation>('checking');
  const [room, setRoom] = useState<IRoom | null>(null);

  useEffect(() => {
    let alive = true;
    setState('checking');
    getRooms()
      .then((rooms) => {
        if (!alive) return;
        const found = rooms.find((r) => r.id === roomId);
        if (found) {
          setRoom(found);
          void openRoom(roomId!);
          if (found.gameId) void openAssetsGame(found.gameId);
          if (found.gameId) void openGameDocs(found.gameId);
          if (found.gameId) openGame(found.gameId);
          if (found.gameId) void openGameSim(found.gameId);
          if (found.gameId) void openGameTuner(found.gameId);
          if (found.gameId) void openGameConfig(found.gameId);
          if (found.gameId) void openGameAnalytics(found.gameId);
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
      closeAssetsGame();
      closeGameDocs();
      closeGame();
      closeGameSim();
      closeGameTuner();
      closeGameConfig();
      closeGameAnalytics();
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
      <Workbench roomContext={<RoomContext roomName={room?.name ?? ''} gameLinked={!!room?.gameId} />} />
      {children}
    </ActiveRoomProvider>
  );
}

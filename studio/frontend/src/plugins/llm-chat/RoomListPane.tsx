import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { llmChatHooks } from './state';
import { createRoom, openRoom, loadRooms } from './actions';
import { bumpRenderCount } from '../../app/renderCount';

export function RoomListPane() {
  const s = llmChatHooks.usePluginState();
  const [name, setName] = useState('');
  bumpRenderCount('RoomListPane');

  const rooms = s.rooms.get();
  const status = s.roomsStatus.get();

  return (
    <div data-testid="room-list-pane" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 4 }}>
        <input data-testid="new-room-input" value={name} placeholder="New room name" onChange={(e) => setName(e.target.value)} />
        <Button
          data-testid="new-room-create"
          onClick={() => {
            if (name.trim()) {
              void createRoom(name.trim());
              setName('');
            }
          }}
        >
          Create
        </Button>
      </div>

      {status === 'error' && (
        <div data-testid="rooms-error">
          Couldn't load rooms.{' '}
          <Button data-testid="rooms-retry" onClick={() => void loadRooms()}>
            Retry
          </Button>
        </div>
      )}

      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {rooms.map((r) => (
          <li key={r.id}>
            <Button data-testid={`room-open-${r.id}`} onClick={() => void openRoom(r.id)}>
              {r.name}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { getRooms, createRoom } from '../../plugins/llm-chat/restClient';
import type { IRoom } from '../../plugins/llm-chat/state';
import { notify } from '../../lib/notify';

type Status = 'loading' | 'ready' | 'error';

export function RoomPicker() {
  const navigate = useNavigate();
  const [rooms, setRooms] = useState<IRoom[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [newName, setNewName] = useState('');

  async function load() {
    setStatus('loading');
    try {
      setRooms(await getRooms());
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    try {
      const room = await createRoom(name);
      navigate(`/room/${room.id}`);
    } catch {
      notify.error('Could not create room');
    }
  }

  return (
    <div data-testid="room-picker" style={{ maxWidth: 560, margin: '48px auto', padding: 16 }}>
      <h1 style={{ fontSize: '1.25rem' }}>Rooms</h1>
      <form onSubmit={onCreate} style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New room name…" style={{ flex: 1 }} />
        <button type="submit">Create</button>
      </form>
      {status === 'loading' && <p>Loading rooms…</p>}
      {status === 'error' && (
        <p>
          Couldn't load rooms.{' '}
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </p>
      )}
      {status === 'ready' && (
        <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rooms.map((r) => (
            <li key={r.id}>
              <button type="button" style={{ width: '100%', textAlign: 'left' }} onClick={() => navigate(`/room/${r.id}`)}>
                {r.name}
              </button>
            </li>
          ))}
          {rooms.length === 0 && <li>No rooms yet — create one above.</li>}
        </ul>
      )}
    </div>
  );
}

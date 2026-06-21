import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { getRooms, createRoom } from '../../plugins/llm-chat/restClient';
import type { IRoom } from '../../plugins/llm-chat/state';
import { notify } from '../../lib/notify';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';

type Status = 'loading' | 'ready' | 'error';

export function RoomPicker() {
  const navigate = useNavigate();
  const [rooms, setRooms] = useState<IRoom[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

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
    setCreating(true);
    try {
      const room = await createRoom(name);
      setNewName('');
      notify.info('Room created');
      navigate(`/room/${room.id}`);
    } catch {
      notify.error('Could not create room');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div data-testid="room-picker" className="mx-auto mt-12 w-full max-w-xl p-4">
      <h1 className="mb-4 text-xl font-semibold">Rooms</h1>
      <form onSubmit={onCreate} className="mb-4 flex gap-2">
        <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New room name…" className="flex-1" />
        <Button type="submit" disabled={creating}>
          Create
        </Button>
      </form>
      {status === 'loading' && <p className="text-sm text-muted-foreground">Loading rooms…</p>}
      {status === 'error' && (
        <p className="text-sm text-destructive">
          Couldn't load rooms.{' '}
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </p>
      )}
      {status === 'ready' && (
        <Card>
          <CardContent className="flex flex-col gap-1 pt-4">
            {rooms.map((r) => (
              <Button key={r.id} type="button" variant="ghost" className="w-full justify-start" onClick={() => navigate(`/room/${r.id}`)}>
                {r.name}
              </Button>
            ))}
            {rooms.length === 0 && <p className="text-sm text-muted-foreground">No rooms yet — create one above.</p>}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

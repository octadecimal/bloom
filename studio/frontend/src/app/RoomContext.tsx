import { Link } from 'react-router-dom';
import { ChevronLeft, Gamepad2 } from 'lucide-react';

export interface IRoomContextProps {
  roomName: string;
  gameLinked: boolean;
}

export function RoomContext({ roomName, gameLinked }: IRoomContextProps) {
  return (
    <div className="flex items-center gap-2">
      <Link
        to="/"
        title="Back to rooms"
        className="flex items-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft aria-hidden className="h-3.5 w-3.5" />
        Rooms
      </Link>
      <span aria-hidden className="text-faint">
        /
      </span>
      <span className="text-[13px] font-medium text-foreground">{roomName}</span>
      {gameLinked && (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-raised px-2 py-0.5 text-[11px] text-muted-foreground">
          <Gamepad2 aria-hidden className="h-3 w-3" />
          Game
        </span>
      )}
    </div>
  );
}

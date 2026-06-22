import { useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { useSession } from '../session/SessionContext';
import { Button } from '@/components/ui/button';

export function SwitchUser() {
  const { username, logout } = useSession();
  const navigate = useNavigate();
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden
        className="grid h-[18px] w-[18px] place-items-center rounded-full border border-border bg-raised-hover text-[10px] text-muted-foreground"
      >
        {(username ?? '').slice(0, 1).toLowerCase()}
      </span>
      <span className="text-[13px] text-muted-foreground">{username}</span>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Switch user"
        title="Switch user"
        onClick={() => {
          logout();
          navigate('/login', { replace: true });
        }}
      >
        <LogOut aria-hidden className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

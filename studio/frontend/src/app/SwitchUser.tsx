import { useNavigate } from 'react-router-dom';
import { useSession } from '../session/SessionContext';

export function SwitchUser() {
  const { username, logout } = useSession();
  const navigate = useNavigate();
  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-sm text-muted-foreground">{username}</span>
      <button
        type="button"
        onClick={() => {
          logout();
          navigate('/login', { replace: true });
        }}
      >
        Switch user
      </button>
    </span>
  );
}

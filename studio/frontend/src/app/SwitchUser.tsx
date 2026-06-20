import { useNavigate } from 'react-router-dom';
import { useSession } from '../session/SessionContext';

export function SwitchUser() {
  const { username, logout } = useSession();
  const navigate = useNavigate();
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: '0.85rem', opacity: 0.8 }}>{username}</span>
      <button type="button" onClick={() => { logout(); navigate('/login', { replace: true }); }}>
        Switch user
      </button>
    </span>
  );
}

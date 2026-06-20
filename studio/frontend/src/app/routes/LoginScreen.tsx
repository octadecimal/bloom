import { useState, type FormEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSession } from '../../session/SessionContext';

export function LoginScreen() {
  const { login } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [name, setName] = useState('');
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const t = name.trim();
    if (!t) return;
    login(t);
    navigate(from, { replace: true });
  }

  return (
    <div data-testid="login-screen" style={{ display: 'grid', placeItems: 'center', height: '100vh' }}>
      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 280 }}>
        <h1 style={{ margin: 0, fontSize: '1.25rem' }}>Bloom Studio</h1>
        <label htmlFor="username">Your name</label>
        <input id="username" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. ada" />
        <button type="submit">Continue</button>
      </form>
    </div>
  );
}

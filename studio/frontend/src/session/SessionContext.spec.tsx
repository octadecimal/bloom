import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { SessionProvider, useSession } from './SessionContext';

beforeEach(() => localStorage.clear());

function Probe() {
  const { username, login, logout } = useSession();
  return (
    <div>
      <span data-testid="name">{username ?? 'anon'}</span>
      <button onClick={() => login('ada')}>login</button>
      <button onClick={logout}>logout</button>
    </div>
  );
}
const renderProbe = () => render(<SessionProvider><Probe /></SessionProvider>);

describe('SessionContext', () => {
  it('starts anon', () => {
    renderProbe();
    expect(screen.getByTestId('name')).toHaveTextContent('anon');
  });
  it('login sets + persists', () => {
    renderProbe();
    act(() => screen.getByText('login').click());
    expect(screen.getByTestId('name')).toHaveTextContent('ada');
    expect(localStorage.getItem('bloom.studio.session')).toContain('ada');
  });
  it('logout clears', () => {
    renderProbe();
    act(() => screen.getByText('login').click());
    act(() => screen.getByText('logout').click());
    expect(screen.getByTestId('name')).toHaveTextContent('anon');
  });
});

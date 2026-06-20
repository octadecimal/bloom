import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { SessionProvider } from '../../session/SessionContext';
import { LoginScreen } from './LoginScreen';

beforeEach(() => localStorage.clear());

function tree(initial: { pathname: string; state?: unknown }) {
  return (
    <SessionProvider>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/login" element={<LoginScreen />} />
          <Route path="/" element={<div>PICKER</div>} />
          <Route path="/room/:roomId" element={<div>ROOM</div>} />
        </Routes>
      </MemoryRouter>
    </SessionProvider>
  );
}

describe('LoginScreen', () => {
  it('logs in → picker by default', async () => {
    render(tree({ pathname: '/login' }));
    await userEvent.type(screen.getByLabelText(/name/i), 'ada');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByText('PICKER')).toBeInTheDocument();
    expect(localStorage.getItem('bloom.studio.session')).toContain('ada');
  });
  it('honors the return-url', async () => {
    render(tree({ pathname: '/login', state: { from: '/room/r-9' } }));
    await userEvent.type(screen.getByLabelText(/name/i), 'ada');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByText('ROOM')).toBeInTheDocument();
  });
  it('does not submit empty', async () => {
    render(tree({ pathname: '/login' }));
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.queryByText('PICKER')).not.toBeInTheDocument();
  });
});

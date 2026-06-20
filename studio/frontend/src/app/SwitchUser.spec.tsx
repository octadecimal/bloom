import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { SessionProvider } from '../session/SessionContext';
import { saveSession } from '../session/session';
import { SwitchUser } from './SwitchUser';

beforeEach(() => localStorage.clear());

function tree() {
  return (
    <SessionProvider>
      <MemoryRouter initialEntries={['/room/r1']}>
        <Routes>
          <Route path="/room/:roomId" element={<SwitchUser />} />
          <Route path="/login" element={<div>LOGIN</div>} />
        </Routes>
      </MemoryRouter>
    </SessionProvider>
  );
}

describe('SwitchUser', () => {
  it('shows the username', () => {
    saveSession('ada');
    render(tree());
    expect(screen.getByText(/ada/)).toBeInTheDocument();
  });
  it('logs out → /login + clears storage', async () => {
    saveSession('ada');
    render(tree());
    await userEvent.click(screen.getByRole('button', { name: /switch user/i }));
    expect(screen.getByText('LOGIN')).toBeInTheDocument();
    expect(localStorage.getItem('bloom.studio.session')).toBeNull();
  });
});

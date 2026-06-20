import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { SessionProvider } from '../../session/SessionContext';
import { saveSession } from '../../session/session';
import { RequireSession } from './RequireSession';

beforeEach(() => localStorage.clear());

function tree(initial: string) {
  return (
    <SessionProvider>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/login" element={<div>LOGIN</div>} />
          <Route element={<RequireSession />}>
            <Route path="/" element={<div>HOME</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </SessionProvider>
  );
}

describe('RequireSession', () => {
  it('redirects to /login when no username', () => {
    render(tree('/'));
    expect(screen.getByText('LOGIN')).toBeInTheDocument();
  });
  it('renders the outlet when logged in', () => {
    saveSession('ada');
    render(tree('/'));
    expect(screen.getByText('HOME')).toBeInTheDocument();
  });
});

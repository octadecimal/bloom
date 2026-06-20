import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// The root route is a dedicated picker page — the Workbench must NOT be mounted
// there (it lives inside a room). Mock the leaves so we only assert routing.
vi.mock('./RequireSession', () => {
  const { Outlet } = require('react-router-dom');
  return { RequireSession: () => <Outlet /> };
});
vi.mock('./RoomPicker', () => ({ RoomPicker: () => <div data-testid="picker">PICKER</div> }));
vi.mock('./RoomRoute', () => ({ RoomRoute: () => <div>ROOM</div> }));
vi.mock('./LoginScreen', () => ({ LoginScreen: () => <div>LOGIN</div> }));
vi.mock('../Workbench', () => ({ Workbench: () => <div data-testid="workbench">WB</div> }));

import { AppRoutes } from './AppRoutes';

describe('AppRoutes', () => {
  it('renders the RoomPicker as a full page at / without the Workbench', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <AppRoutes />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('picker')).toBeInTheDocument();
    expect(screen.queryByTestId('workbench')).not.toBeInTheDocument();
  });
});

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RoomContext } from './RoomContext';

function renderIn(ui: React.ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('RoomContext', () => {
  it('links back to the rooms picker', () => {
    renderIn(<RoomContext roomName="Verdant Hollow" gameLinked={false} />);
    expect(screen.getByRole('link', { name: /rooms/i })).toHaveAttribute('href', '/');
  });

  it('shows the room name', () => {
    renderIn(<RoomContext roomName="Verdant Hollow" gameLinked={false} />);
    expect(screen.getByText('Verdant Hollow')).toBeInTheDocument();
  });

  it('shows the Game chip when a game is linked', () => {
    renderIn(<RoomContext roomName="Verdant Hollow" gameLinked={true} />);
    expect(screen.getByText('Game')).toBeInTheDocument();
  });

  it('hides the Game chip when no game is linked', () => {
    renderIn(<RoomContext roomName="Verdant Hollow" gameLinked={false} />);
    expect(screen.queryByText('Game')).toBeNull();
  });
});

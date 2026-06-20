import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActiveRoomProvider, useActiveRoomId } from './activeRoom';

function Probe() {
  return <span data-testid="rid">{useActiveRoomId()}</span>;
}

describe('useActiveRoomId', () => {
  it('exposes the provided id', () => {
    render(
      <ActiveRoomProvider roomId="r-42">
        <Probe />
      </ActiveRoomProvider>,
    );
    expect(screen.getByTestId('rid')).toHaveTextContent('r-42');
  });
  it('throws outside a room route', () => {
    expect(() => render(<Probe />)).toThrow(/useActiveRoomId/);
  });
});

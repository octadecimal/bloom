import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatTiles } from './StatTiles';
import type { ITailMetrics } from '../state';

const TAIL: ITailMetrics = {
  maxWin: 842.5,
  pGE100x: 0.0031,
  pLosingSpin: 0.62,
  longestDeadStreak: 47,
  bonusTriggerRate: 0.014,
};

describe('StatTiles', () => {
  it('renders under the tail-tiles testid', () => {
    render(<StatTiles tail={TAIL} />);
    expect(screen.getByTestId('tail-tiles')).toBeTruthy();
  });

  it('shows the max win tile', () => {
    render(<StatTiles tail={TAIL} />);
    const tile = screen.getByTestId('stat-max-win');
    expect(tile.textContent).toContain('842.5');
  });

  it('shows the P(>=100x) tile', () => {
    render(<StatTiles tail={TAIL} />);
    const tile = screen.getByTestId('stat-p-ge-100x');
    expect(tile.textContent).toMatch(/0\.31|0\.3%/);
  });

  it('shows losing-spin, dead-streak, and bonus-trigger tiles', () => {
    render(<StatTiles tail={TAIL} />);
    expect(screen.getByTestId('stat-p-losing-spin')).toBeTruthy();
    expect(screen.getByTestId('stat-longest-dead-streak').textContent).toContain('47');
    expect(screen.getByTestId('stat-bonus-trigger-rate')).toBeTruthy();
  });
});

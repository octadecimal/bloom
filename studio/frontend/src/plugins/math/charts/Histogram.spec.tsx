import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Histogram } from './Histogram';
import type { IHistogramBin } from '../state';

const BINS: IHistogramBin[] = [
  { binLo: 0, binHi: 1, base: 40, feature: 0 },
  { binLo: 1, binHi: 2, base: 20, feature: 2 },
  { binLo: 2, binHi: 5, base: 5, feature: 8 },
  { binLo: 100, binHi: 200, base: 0, feature: 2 },
  { binLo: 2000, binHi: null, base: 0, feature: 1 },
];

describe('Histogram', () => {
  it('renders under the win-distribution testid with one bar per bin plus the zero column', () => {
    render(<Histogram bins={BINS} zeroCount={300} />);
    const root = screen.getByTestId('win-distribution');
    expect(root).toBeTruthy();
    const bars = screen.getAllByTestId('hist-bar');
    expect(bars).toHaveLength(BINS.length + 1); // + the zero/loss column
  });

  it('renders the open-ended top bin compacted as "…k×+" (wide labels overlap otherwise)', () => {
    render(<Histogram bins={BINS} zeroCount={300} />);
    expect(screen.getByText('2k×+')).toBeTruthy();
  });

  it('renders a non-empty svg element (SVG/CSS mark, not the IChart seam)', () => {
    const { container } = render(<Histogram bins={BINS} zeroCount={300} />);
    expect(container.querySelector('svg')).toBeTruthy();
  });
});

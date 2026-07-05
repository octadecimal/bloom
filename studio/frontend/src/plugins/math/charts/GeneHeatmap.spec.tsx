import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GeneHeatmap } from './GeneHeatmap';
import type { IGenFrame } from '../state';

function frame(generation: number, geneAgreement: number[]): IGenFrame {
  return {
    generation,
    best: { fitness: -0.1 * generation, rtp: 0.9, volatility: 2 },
    population: { min: 0.1, q1: 0.2, median: 0.3, q3: 0.4, max: 0.5, mean: 0.3, diversity: 0.4 },
    geneAgreement,
  };
}

const FRAMES: IGenFrame[] = [frame(0, [0.1, 0.2, 0.9]), frame(1, [0.3, 0.4, 0.85]), frame(2, [0.6, 0.5, 0.8])];

describe('GeneHeatmap', () => {
  it('renders one row per gene dimension', () => {
    render(<GeneHeatmap frames={FRAMES} selectedGeneration="live" />);
    expect(screen.getAllByTestId('gene-heatmap-row')).toHaveLength(3);
  });

  it('renders one cell per generation within each row', () => {
    render(<GeneHeatmap frames={FRAMES} selectedGeneration="live" />);
    const rows = screen.getAllByTestId('gene-heatmap-row');
    for (const row of rows) {
      expect(row.querySelectorAll('[data-testid="gene-heatmap-cell"]')).toHaveLength(3);
    }
  });

  it('marks the selected generation column and no other', () => {
    render(<GeneHeatmap frames={FRAMES} selectedGeneration={1} />);
    const cells = screen.getAllByTestId('gene-heatmap-cell');
    const selected = cells.filter((c) => c.getAttribute('data-selected') === 'true');
    // One selected cell per row (3 rows).
    expect(selected).toHaveLength(3);
    expect(selected.every((c) => c.getAttribute('data-generation') === '1')).toBe(true);
  });

  it('marks the newest generation as selected in live mode', () => {
    render(<GeneHeatmap frames={FRAMES} selectedGeneration="live" />);
    const cells = screen.getAllByTestId('gene-heatmap-cell');
    const selected = cells.filter((c) => c.getAttribute('data-selected') === 'true');
    expect(selected.every((c) => c.getAttribute('data-generation') === '2')).toBe(true);
  });

  it('renders a placeholder when there is no gene data yet', () => {
    render(<GeneHeatmap frames={[]} selectedGeneration="live" />);
    expect(screen.getByTestId('gene-heatmap')).toBeTruthy();
    expect(screen.queryAllByTestId('gene-heatmap-row')).toHaveLength(0);
  });

  it('sizes gene rows at a fixed 14px so the strip hugs its content', () => {
    render(<GeneHeatmap frames={FRAMES} selectedGeneration="live" />);
    const grid = screen.getAllByTestId('gene-heatmap-row')[0].parentElement!;
    expect(grid.style.gridTemplateRows).toBe('repeat(3, 14px)');
  });

  it('shows the cold-to-hot legend chip', () => {
    render(<GeneHeatmap frames={FRAMES} selectedGeneration="live" />);
    expect(screen.getByTestId('gene-heatmap-legend')).toBeTruthy();
  });

  it('hides the legend chip when there is no gene data', () => {
    render(<GeneHeatmap frames={[]} selectedGeneration="live" />);
    expect(screen.queryByTestId('gene-heatmap-legend')).toBeNull();
  });
});

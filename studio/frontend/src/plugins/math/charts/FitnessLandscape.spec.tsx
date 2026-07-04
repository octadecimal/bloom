import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FitnessLandscape, buildFitnessLandscapeData, playheadPercent } from './FitnessLandscape';
import type { IGenFrame } from '../state';

vi.mock('./UPlotChart', () => ({
  UPlotChart: ({ className }: { className?: string }) => <div data-testid="uplot-chart-stub" className={className} />,
}));

function frame(generation: number): IGenFrame {
  return {
    generation,
    best: { fitness: -1 / (generation + 1), rtp: 0.9, volatility: 2 },
    population: { min: 0.1 + generation * 0.01, q1: 0.2, median: 0.3, q3: 0.4, max: 0.5 - generation * 0.01, mean: 0.3, diversity: 0.4 },
    geneAgreement: [0.5],
  };
}

const FRAMES = [frame(0), frame(1), frame(2)];

describe('buildFitnessLandscapeData', () => {
  it('builds a best-fitness series aligned to generation', () => {
    const data = buildFitnessLandscapeData(FRAMES);
    expect(data.x).toEqual([0, 1, 2]);
    expect(data.series).toHaveLength(1);
    expect(data.series[0].values).toEqual(FRAMES.map((f) => f.best.fitness));
  });

  it('builds a min-max band and a q1-q3 (IQR) band', () => {
    const data = buildFitnessLandscapeData(FRAMES);
    expect(data.bands).toHaveLength(2);
    const [range, iqr] = data.bands!;
    expect(range.loValues).toEqual(FRAMES.map((f) => f.population.min));
    expect(range.hiValues).toEqual(FRAMES.map((f) => f.population.max));
    expect(iqr.loValues).toEqual(FRAMES.map((f) => f.population.q1));
    expect(iqr.hiValues).toEqual(FRAMES.map((f) => f.population.q3));
  });
});

describe('playheadPercent', () => {
  it('sits at the right edge (100%) in live mode', () => {
    expect(playheadPercent(FRAMES, 'live')).toBe(100);
  });

  it("places the playhead at the scrubbed generation's position along the timeline", () => {
    expect(playheadPercent(FRAMES, 1)).toBe(50);
    expect(playheadPercent(FRAMES, 0)).toBe(0);
  });

  it('is 0 for a single frame (no timeline to place a marker on)', () => {
    expect(playheadPercent([frame(0)], 'live')).toBe(0);
  });

  it('is 0 for an empty frame list', () => {
    expect(playheadPercent([], 'live')).toBe(0);
  });
});

describe('FitnessLandscape', () => {
  it('renders the chart and a playhead marker', () => {
    render(<FitnessLandscape frames={FRAMES} selectedGeneration="live" />);
    expect(screen.getByTestId('fitness-landscape')).toBeTruthy();
    expect(screen.getByTestId('uplot-chart-stub')).toBeTruthy();
    const playhead = screen.getByTestId('fitness-landscape-playhead');
    expect(playhead.style.left).toBe('100%');
  });

  it('moves the playhead when a specific generation is selected', () => {
    render(<FitnessLandscape frames={FRAMES} selectedGeneration={1} />);
    const playhead = screen.getByTestId('fitness-landscape-playhead');
    expect(playhead.style.left).toBe('50%');
  });
});

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FitnessLandscape, buildFitnessLandscapeData, playheadGeneration } from './FitnessLandscape';
import type { IChartData } from './IChart';
import type { IGenFrame } from '../state';

// The stub surfaces the playheadX the component feeds the seam — the playhead
// is drawn inside the chart by the adapter now, not as an overlay div.
vi.mock('./UPlotChart', () => ({
  UPlotChart: ({ className, data }: { className?: string; data: IChartData }) => (
    <div data-testid="uplot-chart-stub" className={className} data-playhead-x={data.playheadX ?? ''} />
  ),
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

describe('playheadGeneration', () => {
  it('is the newest generation in live mode', () => {
    expect(playheadGeneration(FRAMES, 'live')).toBe(2);
  });

  it('is the scrubbed generation when it exists in the frames', () => {
    expect(playheadGeneration(FRAMES, 1)).toBe(1);
    expect(playheadGeneration(FRAMES, 0)).toBe(0);
  });

  it('falls back to the newest generation when the scrubbed one is unknown', () => {
    expect(playheadGeneration(FRAMES, 99)).toBe(2);
  });

  it('is undefined with no frames (nothing to mark)', () => {
    expect(playheadGeneration([], 'live')).toBeUndefined();
  });
});

describe('FitnessLandscape', () => {
  it('feeds the newest generation as playheadX in live mode', () => {
    render(<FitnessLandscape frames={FRAMES} selectedGeneration="live" />);
    expect(screen.getByTestId('fitness-landscape')).toBeTruthy();
    expect(screen.getByTestId('uplot-chart-stub').getAttribute('data-playhead-x')).toBe('2');
  });

  it('feeds the scrubbed generation as playheadX when one is selected', () => {
    render(<FitnessLandscape frames={FRAMES} selectedGeneration={1} />);
    expect(screen.getByTestId('uplot-chart-stub').getAttribute('data-playhead-x')).toBe('1');
  });
});

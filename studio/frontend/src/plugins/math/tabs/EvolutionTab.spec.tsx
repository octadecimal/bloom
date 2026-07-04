import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EvolutionTab } from './EvolutionTab';
import type { IGenFrame } from '../state';
import type { IChartData } from '../charts/IChart';

// Composition test, not a chart-rendering test — real uPlot needs a canvas 2D
// context jsdom doesn't provide (mirrors MathProfileTab.spec.tsx). GeneHeatmap
// and Scrubber are hand-rolled SVG/CSS/inputs and need no stub. The stub
// surfaces each chart's series labels so tests can assert what the homing
// charts feed the seam without a real uPlot instance.
vi.mock('../charts/UPlotChart', () => ({
  UPlotChart: ({ className, data }: { className?: string; data: IChartData }) => (
    <div
      data-testid="uplot-chart-stub"
      className={className}
      data-series-labels={data.series.map((s) => s.label).join('|')}
      data-sparkline={data.sparkline === true ? 'true' : 'false'}
    />
  ),
}));

function frame(generation: number): IGenFrame {
  return {
    generation,
    best: { fitness: -0.1 * generation, rtp: 0.9 + generation * 0.001, volatility: 2 + generation * 0.01 },
    population: { min: 0.1, q1: 0.2, median: 0.3, q3: 0.4, max: 0.5, mean: 0.3, diversity: 0.4 },
    geneAgreement: [0.2, 0.5, 0.8],
  };
}

const FRAMES = [frame(0), frame(1), frame(2)];

describe('EvolutionTab', () => {
  it('renders the five Evolution charts', () => {
    render(<EvolutionTab frames={FRAMES} selectedGeneration="live" onScrub={vi.fn()} />);
    expect(screen.getByTestId('fitness-landscape')).toBeTruthy();
    expect(screen.getByTestId('rtp-homing')).toBeTruthy();
    expect(screen.getByTestId('vol-homing')).toBeTruthy();
    expect(screen.getByTestId('gene-heatmap')).toBeTruthy();
    expect(screen.getByTestId('scrubber')).toBeTruthy();
  });

  it('fills the pane with no inner scroll', () => {
    render(<EvolutionTab frames={FRAMES} selectedGeneration="live" onScrub={vi.fn()} />);
    const root = screen.getByTestId('evolution-tab');
    expect(root.className).toContain('bloom-tab-fill');
  });

  it('draws only the real best-value convergence line on each homing chart (no tautological reference line)', () => {
    render(<EvolutionTab frames={FRAMES} selectedGeneration="live" onScrub={vi.fn()} />);
    for (const [testId, label] of [
      ['rtp-homing', 'Best RTP'],
      ['vol-homing', 'Best volatility'],
    ] as const) {
      const stub = screen.getByTestId(testId).querySelector('[data-testid="uplot-chart-stub"]');
      const labels = stub?.getAttribute('data-series-labels');
      // Exactly one series — the real best line — and nothing implying a target.
      expect(labels).toBe(label);
      expect(labels).not.toMatch(/latest|target/i);
    }
  });

  it('the gene heatmap has one row per gene dimension', () => {
    render(<EvolutionTab frames={FRAMES} selectedGeneration="live" onScrub={vi.fn()} />);
    expect(screen.getAllByTestId('gene-heatmap-row')).toHaveLength(3);
  });

  it('scrubbing dispatches onScrub with the chosen generation', () => {
    const onScrub = vi.fn();
    render(<EvolutionTab frames={FRAMES} selectedGeneration="live" onScrub={onScrub} />);
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '1' } });
    expect(onScrub).toHaveBeenCalledWith(1);
  });

  it('renders a placeholder when there are no frames yet', () => {
    render(<EvolutionTab frames={[]} selectedGeneration="live" onScrub={vi.fn()} />);
    expect(screen.getByTestId('evolution-no-data')).toBeTruthy();
    expect(screen.queryByTestId('fitness-landscape')).toBeNull();
  });

  it('renders the homing charts as sparklines with a big current-value readout', () => {
    render(<EvolutionTab frames={FRAMES} selectedGeneration="live" onScrub={vi.fn()} />);
    // Latest frame: rtp = 0.9 + 2*0.001 = 0.902, volatility = 2 + 2*0.01 = 2.02.
    expect(screen.getByTestId('rtp-homing-value').textContent).toBe('0.9020');
    expect(screen.getByTestId('vol-homing-value').textContent).toBe('2.020');
    for (const testId of ['rtp-homing', 'vol-homing'] as const) {
      const stub = screen.getByTestId(testId).querySelector('[data-testid="uplot-chart-stub"]');
      expect(stub?.getAttribute('data-sparkline')).toBe('true');
    }
  });

  it('the fitness landscape is NOT a sparkline (keeps full axes)', () => {
    render(<EvolutionTab frames={FRAMES} selectedGeneration="live" onScrub={vi.fn()} />);
    const stub = screen.getByTestId('fitness-landscape').querySelector('[data-testid="uplot-chart-stub"]');
    expect(stub?.getAttribute('data-sparkline')).toBe('false');
  });
});

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RunSelector } from './RunSelector';
import type { IMathRun } from '../state';

function run(id: string, verdict: IMathRun['verdict'] = 'pass', createdAt = '2026-07-02T00:00:00Z'): IMathRun {
  return { id, gameId: 'g1', params: {} as never, verdict, metrics: null, trace: [], profile: null, createdAt, durationMs: null };
}

const RUNS = [run('r3', 'near_miss', '2026-07-03T00:00:00Z'), run('r2', 'pass', '2026-07-02T00:00:00Z'), run('r1', 'pass', '2026-07-01T00:00:00Z')];

describe('RunSelector', () => {
  it('shows an empty state when there is no run history', () => {
    render(<RunSelector runs={[]} mode="single" selectedRunId={null} onSelect={vi.fn()} />);
    expect(screen.getByTestId('run-selector-empty')).toBeTruthy();
  });

  it('renders one row per run in the history', () => {
    render(<RunSelector runs={RUNS} mode="single" selectedRunId={null} onSelect={vi.fn()} />);
    for (const r of RUNS) {
      expect(screen.getByTestId(`run-selector-row-${r.id}`)).toBeTruthy();
    }
  });

  describe('single mode (header/active selector)', () => {
    it('calls onSelect with the clicked run id', () => {
      const onSelect = vi.fn();
      render(<RunSelector runs={RUNS} mode="single" selectedRunId={null} onSelect={onSelect} />);
      screen.getByTestId('run-selector-row-r2').click();
      expect(onSelect).toHaveBeenCalledWith('r2');
    });

    it('marks the selectedRunId row as selected', () => {
      render(<RunSelector runs={RUNS} mode="single" selectedRunId="r2" onSelect={vi.fn()} />);
      expect(screen.getByTestId('run-selector-row-r2').getAttribute('aria-selected')).toBe('true');
      expect(screen.getByTestId('run-selector-row-r1').getAttribute('aria-selected')).toBe('false');
    });
  });

  describe('multi mode (Compare selector)', () => {
    it('calls onToggle with the clicked run id', () => {
      const onToggle = vi.fn();
      render(<RunSelector runs={RUNS} mode="multi" selectedRunIds={[]} onToggle={onToggle} />);
      screen.getByTestId('run-selector-row-r1').click();
      expect(onToggle).toHaveBeenCalledWith('r1');
    });

    it('marks selected rows aria-pressed and assigns each a distinct color swatch by selection order', () => {
      render(<RunSelector runs={RUNS} mode="multi" selectedRunIds={['r2', 'r1']} onToggle={vi.fn()} />);
      const rowR2 = screen.getByTestId('run-selector-row-r2');
      const rowR1 = screen.getByTestId('run-selector-row-r1');
      const rowR3 = screen.getByTestId('run-selector-row-r3');
      expect(rowR2.getAttribute('aria-pressed')).toBe('true');
      expect(rowR1.getAttribute('aria-pressed')).toBe('true');
      expect(rowR3.getAttribute('aria-pressed')).toBe('false');

      const swatchR2 = screen.getByTestId('run-selector-swatch-r2');
      const swatchR1 = screen.getByTestId('run-selector-swatch-r1');
      expect(swatchR2.style.getPropertyValue('background')).toContain('--chart-series-1');
      expect(swatchR1.style.getPropertyValue('background')).toContain('--chart-series-2');
      expect(screen.queryByTestId('run-selector-swatch-r3')).toBeNull();
    });

    it('disables further selection once the cap is reached, without disabling already-selected rows', () => {
      const fiveRuns = ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => run(id));
      const sixthRun = run('r6');
      render(<RunSelector runs={[...fiveRuns, sixthRun]} mode="multi" selectedRunIds={['r1', 'r2', 'r3', 'r4', 'r5']} onToggle={vi.fn()} max={5} />);
      expect((screen.getByTestId('run-selector-row-r6') as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByTestId('run-selector-row-r1') as HTMLButtonElement).disabled).toBe(false);
    });

    it('does not disable rows below the cap', () => {
      render(<RunSelector runs={RUNS} mode="multi" selectedRunIds={['r1']} onToggle={vi.fn()} max={5} />);
      expect((screen.getByTestId('run-selector-row-r2') as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('renders the verdict for each run', () => {
    render(<RunSelector runs={RUNS} mode="single" selectedRunId={null} onSelect={vi.fn()} />);
    expect(screen.getByTestId('run-selector-row-r3').textContent).toMatch(/near.?miss/i);
    expect(screen.getByTestId('run-selector-row-r2').textContent).toMatch(/pass/i);
  });
});

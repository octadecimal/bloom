import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ParamSidebar } from './ParamSidebar';
import { MATH_PLUGIN_ID, makeInitialState, mathSlice } from '../state';
import { rootStore } from '../../../state/rootStore';

const tunerParams = {
  masterSeed: 2026,
  population: 24,
  maxGenerations: 40,
  searchCandidateCount: 20000,
  finalCandidateCount: 200000,
  elitism: 2,
  mutationRate: 0.25,
  crossoverRate: 0.9,
  stagnationWindow: 12,
  maxAttempts: 4,
  weights: { rtp: 1, volatility: 1, hitRate: 1 },
};

const curationParams = {
  poolSize: 500,
  candidateCount: 20000,
  masterSeed: 2026,
  rtpTolerance: 0.02,
  realizedCorrectionBand: 0.05,
  bonusRateTolerance: 0.25,
};

beforeEach(() => {
  localStorage.clear();
  rootStore.plugins.nested(MATH_PLUGIN_ID).set(makeInitialState() as never);
  mathSlice().tunerParams.set({ ...tunerParams, weights: { ...tunerParams.weights } });
  mathSlice().curationParams.set({ ...curationParams });
});

describe('ParamSidebar', () => {
  it('renders the six semantic groups with their fields', () => {
    render(<ParamSidebar />);
    expect(screen.getByTestId('advanced-params')).toBeTruthy();
    for (const label of ['Search budget', 'Genetic operators', 'Fitness weights', 'Verification', 'Pool', 'Reproducibility']) {
      expect(screen.getByText(label, { exact: true }), label).toBeTruthy();
    }
    expect(screen.getByTestId('param-master-seed')).toBeTruthy();
    expect(screen.getByTestId('param-crossover')).toBeTruthy();
    expect(screen.getByTestId('param-weight-rtp')).toBeTruthy();
    expect(screen.getByTestId('param-pool-size')).toBeTruthy();
  });

  it('group headers read a tier above field labels (text-1 + hairline divider)', () => {
    render(<ParamSidebar />);
    const header = screen.getByText('Search budget', { exact: true });
    expect(header.className).toContain('text-text-1');
    expect(header.parentElement!.className).toContain('border-b');
    const fieldLabel = screen.getByText('Population', { exact: true });
    expect(fieldLabel.closest('span[tabindex]')!.className).toContain('text-text-2');
  });

  it('group reset restores only its own group — including across slices', () => {
    render(<ParamSidebar />);
    fireEvent.change(screen.getByTestId('param-population'), { target: { value: '50' } });
    fireEvent.change(screen.getByTestId('param-pool-size'), { target: { value: '700' } });
    fireEvent.click(screen.getByTestId('param-reset-search'));
    expect(mathSlice().tunerParams.get()?.population).toBe(24);
    expect(mathSlice().curationParams.get()?.poolSize).toBe(700);
    fireEvent.change(screen.getByTestId('param-master-seed'), { target: { value: '7' } });
    fireEvent.change(screen.getByTestId('param-sim-seed'), { target: { value: '8' } });
    fireEvent.click(screen.getByTestId('param-reset-repro'));
    expect(mathSlice().tunerParams.get()?.masterSeed).toBe(2026);
    expect(mathSlice().curationParams.get()?.masterSeed).toBe(2026);
  });
});

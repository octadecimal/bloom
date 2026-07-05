import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ParamSidebar, useParamSidebarOpen } from './ParamSidebar';
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

function Harness() {
  const [open, toggle] = useParamSidebarOpen();
  return <button data-testid="harness-toggle" aria-pressed={open} onClick={toggle} />;
}

beforeEach(() => {
  localStorage.clear();
  rootStore.plugins.nested(MATH_PLUGIN_ID).set(makeInitialState() as never);
  mathSlice().tunerParams.set({ ...tunerParams, weights: { ...tunerParams.weights } });
  mathSlice().curationParams.set({ ...curationParams });
});

describe('ParamSidebar', () => {
  it('renders all three groups with their fields', () => {
    render(<ParamSidebar />);
    expect(screen.getByTestId('advanced-params')).toBeTruthy();
    expect(screen.getByText('Tuner')).toBeTruthy();
    expect(screen.getByText('Fitness weights')).toBeTruthy();
    expect(screen.getByText('Curation')).toBeTruthy();
    expect(screen.getByTestId('param-master-seed')).toBeTruthy();
    expect(screen.getByTestId('param-crossover')).toBeTruthy();
    expect(screen.getByTestId('param-weight-rtp')).toBeTruthy();
    expect(screen.getByTestId('param-pool-size')).toBeTruthy();
  });

  it('group reset restores only its own group', () => {
    render(<ParamSidebar />);
    fireEvent.change(screen.getByTestId('param-population'), { target: { value: '50' } });
    fireEvent.change(screen.getByTestId('param-pool-size'), { target: { value: '700' } });
    fireEvent.click(screen.getByTestId('param-reset-tuner'));
    expect(mathSlice().tunerParams.get()?.population).toBe(24);
    expect(mathSlice().curationParams.get()?.poolSize).toBe(700);
  });
});

describe('useParamSidebarOpen', () => {
  it('defaults closed and persists a toggle to localStorage', () => {
    render(<Harness />);
    const btn = screen.getByTestId('harness-toggle');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem('bloom.math.sidebar')).toBe('1');
  });

  it('restores a persisted open state', () => {
    localStorage.setItem('bloom.math.sidebar', '1');
    render(<Harness />);
    expect(screen.getByTestId('harness-toggle').getAttribute('aria-pressed')).toBe('true');
  });
});

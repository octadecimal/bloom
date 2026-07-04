import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AdvancedSection } from './AdvancedSection';
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

beforeEach(() => {
  rootStore.plugins.nested(MATH_PLUGIN_ID).set(makeInitialState() as never);
});

describe('AdvancedSection', () => {
  it('is collapsed by default', () => {
    render(<AdvancedSection />);
    expect(screen.queryByTestId('advanced-params')).toBeNull();
  });

  it('expands when advanced-toggle is clicked', () => {
    mathSlice().tunerParams.set(tunerParams);
    render(<AdvancedSection />);
    fireEvent.click(screen.getByTestId('advanced-toggle'));
    expect(screen.getByTestId('advanced-params')).toBeTruthy();
  });

  it('collapses again on a second toggle click', () => {
    mathSlice().tunerParams.set(tunerParams);
    render(<AdvancedSection />);
    fireEvent.click(screen.getByTestId('advanced-toggle'));
    fireEvent.click(screen.getByTestId('advanced-toggle'));
    expect(screen.queryByTestId('advanced-params')).toBeNull();
  });

  it('writes an edited master seed into tunerParams in the slice', () => {
    mathSlice().tunerParams.set(tunerParams);
    render(<AdvancedSection />);
    fireEvent.click(screen.getByTestId('advanced-toggle'));
    fireEvent.change(screen.getByTestId('param-master-seed'), { target: { value: '777' } });
    expect(mathSlice().tunerParams.get()?.masterSeed).toBe(777);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TooltipProvider } from '../../../components/ui/tooltip';
import { ParamField, clampToDef, formatValue } from './ParamField';
import { PARAM_FIELDS } from './paramFields';
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

const def = (key: string) => {
  const d = PARAM_FIELDS.find((f) => f.key === key);
  if (!d) throw new Error(`no def ${key}`);
  return d;
};

function renderField(key: string) {
  return render(
    <TooltipProvider delayDuration={0}>
      <ParamField def={def(key)} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  rootStore.plugins.nested(MATH_PLUGIN_ID).set(makeInitialState() as never);
  mathSlice().tunerParams.set({ ...tunerParams, weights: { ...tunerParams.weights } });
});

describe('ParamField', () => {
  it('renders nothing until its params load', () => {
    mathSlice().tunerParams.set(null);
    renderField('population');
    expect(screen.queryByTestId('param-population')).toBeNull();
  });

  it('writes a valid typed value straight into the slice', () => {
    renderField('master-seed');
    fireEvent.change(screen.getByTestId('param-master-seed'), { target: { value: '777' } });
    expect(mathSlice().tunerParams.get()?.masterSeed).toBe(777);
  });

  it('marks out-of-range input invalid without touching the slice, then clamps on blur', () => {
    renderField('population'); // min 2
    const input = screen.getByTestId('param-population');
    fireEvent.change(input, { target: { value: '0' } });
    expect(mathSlice().tunerParams.get()?.population).toBe(24); // unchanged
    expect(screen.getByTestId('param-population-wrap').getAttribute('data-invalid')).toBe('true');
    fireEvent.blur(input);
    expect(mathSlice().tunerParams.get()?.population).toBe(2); // clamped
    expect(screen.getByTestId('param-population-wrap').getAttribute('data-invalid')).toBeNull();
  });

  it('reverts non-numeric garbage on blur', () => {
    renderField('population');
    const input = screen.getByTestId('param-population');
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(mathSlice().tunerParams.get()?.population).toBe(24);
    fireEvent.blur(input);
    expect(mathSlice().tunerParams.get()?.population).toBe(24);
    expect((input as HTMLInputElement).value).toBe('24');
  });

  it('formats large integers with separators when unfocused, raw when focused', () => {
    renderField('final-spins');
    const input = screen.getByTestId('param-final-spins') as HTMLInputElement;
    expect(input.value).toBe('200,000');
    fireEvent.focus(input);
    expect(input.value).toBe('200000');
    fireEvent.blur(input);
    expect(input.value).toBe('200,000');
  });

  it('steppers step by def.step and clamp; float steps stay clean', () => {
    renderField('mutation'); // 0.25, step 0.05, max 1
    fireEvent.click(screen.getByTestId('param-mutation-up'));
    expect(mathSlice().tunerParams.get()?.mutationRate).toBe(0.3);
    fireEvent.click(screen.getByTestId('param-mutation-down'));
    fireEvent.click(screen.getByTestId('param-mutation-down'));
    expect(mathSlice().tunerParams.get()?.mutationRate).toBe(0.2);
  });

  it('ArrowUp on the input steps too', () => {
    renderField('elitism');
    fireEvent.keyDown(screen.getByTestId('param-elitism'), { key: 'ArrowUp' });
    expect(mathSlice().tunerParams.get()?.elitism).toBe(3);
  });

  it('clampToDef and formatValue behave', () => {
    expect(clampToDef(0.5, def('population'))).toBe(2); // rounds then clamps... rounds 0.5→1 (banker-free Math.round), clamps to 2
    expect(clampToDef(7.4, def('elitism'))).toBe(7);
    expect(clampToDef(2, def('mutation'))).toBe(1); // max 1
    expect(formatValue(20000, def('search-spins'))).toBe('20,000');
    expect(formatValue(0.25, def('mutation'))).toBe('0.25');
    expect(formatValue(999, def('elitism'))).toBe('999');
  });
});

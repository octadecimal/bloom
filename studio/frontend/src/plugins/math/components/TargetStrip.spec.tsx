import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TargetStrip } from './TargetStrip';
import { MATH_PLUGIN_ID, makeInitialState, mathSlice } from '../state';
import { rootStore } from '../../../state/rootStore';

const editTargetField = vi.fn();
vi.mock('../actions', () => ({
  editTargetField: (key: string, value: string) => editTargetField(key, value),
}));

beforeEach(() => {
  rootStore.plugins.nested(MATH_PLUGIN_ID).set(makeInitialState() as never);
  editTargetField.mockReset();
});

describe('TargetStrip', () => {
  it('renders null when targetFields is not set', () => {
    const { container } = render(<TargetStrip />);
    expect(container.firstChild).toBeNull();
  });

  it('renders three input fields for rtp, volatility, and bonus rate', () => {
    mathSlice().targetFields.set({ rtp: '92%', volatility: 'medium', bonusHitRate: '1:150' });
    render(<TargetStrip />);
    expect(screen.getByTestId('target-rtp')).toBeTruthy();
    expect(screen.getByTestId('target-volatility')).toBeTruthy();
    expect(screen.getByTestId('target-bonus-rate')).toBeTruthy();
  });

  it('populates input values from targetFields', () => {
    mathSlice().targetFields.set({ rtp: '92%', volatility: 'medium', bonusHitRate: '1:150' });
    render(<TargetStrip />);
    expect((screen.getByTestId('target-rtp') as HTMLInputElement).value).toBe('92%');
    expect((screen.getByTestId('target-volatility') as HTMLSelectElement).value).toBe('medium');
    expect((screen.getByTestId('target-bonus-rate') as HTMLInputElement).value).toBe('1:150');
  });

  it('calls editTargetField on rtp input change', () => {
    mathSlice().targetFields.set({ rtp: '92%', volatility: 'medium', bonusHitRate: '1:150' });
    render(<TargetStrip />);
    fireEvent.change(screen.getByTestId('target-rtp'), { target: { value: '95%' } });
    expect(editTargetField).toHaveBeenCalledWith('rtp', '95%');
  });

  it('calls editTargetField on volatility select change', () => {
    mathSlice().targetFields.set({ rtp: '92%', volatility: 'medium', bonusHitRate: '1:150' });
    render(<TargetStrip />);
    fireEvent.change(screen.getByTestId('target-volatility'), { target: { value: 'high' } });
    expect(editTargetField).toHaveBeenCalledWith('volatility', 'high');
  });

  it('calls editTargetField on bonus rate input change', () => {
    mathSlice().targetFields.set({ rtp: '92%', volatility: 'medium', bonusHitRate: '1:150' });
    render(<TargetStrip />);
    fireEvent.change(screen.getByTestId('target-bonus-rate'), { target: { value: '1:200' } });
    expect(editTargetField).toHaveBeenCalledWith('bonusHitRate', '1:200');
  });

  it('renders volatility select with four options: low, medium, medium-high, high', () => {
    mathSlice().targetFields.set({ rtp: '92%', volatility: 'medium', bonusHitRate: '1:150' });
    render(<TargetStrip />);
    const select = screen.getByTestId('target-volatility') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toContain('low');
    expect(options).toContain('medium');
    expect(options).toContain('medium-high');
    expect(options).toContain('high');
  });

  it('renders derived target bands when derivedTarget is set', () => {
    mathSlice().targetFields.set({ rtp: '92%', volatility: 'medium', bonusHitRate: '1:150' });
    mathSlice().derivedTarget.set({
      rtp_target: 0.92,
      rtp_tolerance: 0.005,
      volatility_min: 2.0,
      volatility_max: 4.5,
      bonus_hit_rate_bands: [],
    });
    render(<TargetStrip />);
    const bands = screen.getByTestId('target-bands');
    expect(bands.textContent).toContain('0.915');
    expect(bands.textContent).toContain('0.925');
    expect(bands.textContent).toContain('2');
    expect(bands.textContent).toContain('4.5');
  });

  it('renders infinity symbol when volatility_max is very large', () => {
    mathSlice().targetFields.set({ rtp: '92%', volatility: 'medium', bonusHitRate: '1:150' });
    mathSlice().derivedTarget.set({
      rtp_target: 0.92,
      rtp_tolerance: 0.005,
      volatility_min: 2.0,
      volatility_max: 1e9,
      bonus_hit_rate_bands: [],
    });
    render(<TargetStrip />);
    const bands = screen.getByTestId('target-bands');
    expect(bands.textContent).toContain('∞');
  });

  it('renders targetGap when set', () => {
    mathSlice().targetFields.set({ rtp: '92%', volatility: 'medium', bonusHitRate: '1:150' });
    mathSlice().targetGap.set('Missing volatility value');
    render(<TargetStrip />);
    expect(screen.getByTestId('target-gap')).toBeTruthy();
    expect(screen.getByTestId('target-gap').textContent).toBe('Missing volatility value');
  });

  it('does not render targetGap when not set', () => {
    mathSlice().targetFields.set({ rtp: '92%', volatility: 'medium', bonusHitRate: '1:150' });
    mathSlice().targetGap.set(null);
    render(<TargetStrip />);
    expect(screen.queryByTestId('target-gap')).toBeNull();
  });

  it('renders save status when not idle', () => {
    mathSlice().targetFields.set({ rtp: '92%', volatility: 'medium', bonusHitRate: '1:150' });
    mathSlice().targetSaveStatus.set('saving');
    render(<TargetStrip />);
    expect(screen.getByTestId('target-save-status')).toBeTruthy();
    expect(screen.getByTestId('target-save-status').textContent).toBe('saving…');
  });

  it('renders "saved" status message', () => {
    mathSlice().targetFields.set({ rtp: '92%', volatility: 'medium', bonusHitRate: '1:150' });
    mathSlice().targetSaveStatus.set('saved');
    render(<TargetStrip />);
    expect(screen.getByTestId('target-save-status')).toBeTruthy();
    expect(screen.getByTestId('target-save-status').textContent).toBe('saved');
  });

  it('renders "save failed" status message with danger color on error', () => {
    mathSlice().targetFields.set({ rtp: '92%', volatility: 'medium', bonusHitRate: '1:150' });
    mathSlice().targetSaveStatus.set('error');
    render(<TargetStrip />);
    const saveStatus = screen.getByTestId('target-save-status');
    expect(saveStatus.textContent).toBe('save failed');
    expect(saveStatus.className).toContain('text-danger');
  });

  it('does not render save status when idle', () => {
    mathSlice().targetFields.set({ rtp: '92%', volatility: 'medium', bonusHitRate: '1:150' });
    mathSlice().targetSaveStatus.set('idle');
    render(<TargetStrip />);
    expect(screen.queryByTestId('target-save-status')).toBeNull();
  });

  it('hides the bonus-rate input for a composed@1 game but still renders RTP and volatility', () => {
    mathSlice().targetFields.set({ rtp: '92%', volatility: 'medium', bonusHitRate: '1:150' });
    mathSlice().family.set('composed@1');
    render(<TargetStrip />);
    expect(screen.queryByTestId('target-bonus-rate')).toBeNull();
    expect(screen.getByTestId('target-rtp')).toBeTruthy();
    expect(screen.getByTestId('target-volatility')).toBeTruthy();
  });

  it('renders the bonus-rate input for a slots@1 game', () => {
    mathSlice().targetFields.set({ rtp: '92%', volatility: 'medium', bonusHitRate: '1:150' });
    mathSlice().family.set('slots@1');
    render(<TargetStrip />);
    expect(screen.getByTestId('target-bonus-rate')).toBeTruthy();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GenerateBar } from './GenerateBar';
import { MATH_PLUGIN_ID, makeInitialState, mathSlice } from '../state';
import { rootStore } from '../../../state/rootStore';

const generateMath = vi.fn();
const verifyMath = vi.fn();
const cancelMath = vi.fn();
vi.mock('../actions', () => ({
  generateMath: () => generateMath(),
  verifyMath: () => verifyMath(),
  cancelMath: () => cancelMath(),
}));

beforeEach(() => {
  rootStore.plugins.nested(MATH_PLUGIN_ID).set(makeInitialState() as never);
  generateMath.mockReset();
  verifyMath.mockReset();
  cancelMath.mockReset();
});

describe('GenerateBar', () => {
  it('enables the generate button by default', () => {
    render(<GenerateBar />);
    expect((screen.getByTestId('generate-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('calls generateMath when Generate is clicked', () => {
    render(<GenerateBar />);
    fireEvent.click(screen.getByTestId('generate-button'));
    expect(generateMath).toHaveBeenCalled();
  });

  it('swaps Generate for an enabled Cancel while tuning; verify stays disabled', () => {
    mathSlice().genStatus.set('tuning');
    render(<GenerateBar />);
    expect(screen.queryByTestId('generate-button')).toBeNull();
    expect((screen.getByTestId('cancel-button') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('verify-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows Cancel even when all sections are locked (cancel is never gated)', () => {
    mathSlice().genStatus.set('verifying');
    mathSlice().locks.set({ reels: true, paytable: true, bonus: true });
    render(<GenerateBar />);
    expect((screen.getByTestId('cancel-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('calls cancelMath when Cancel is clicked', () => {
    mathSlice().genStatus.set('tuning');
    render(<GenerateBar />);
    fireEvent.click(screen.getByTestId('cancel-button'));
    expect(cancelMath).toHaveBeenCalled();
  });

  it('shows a disabled Cancelling… button while cancelling', () => {
    mathSlice().genStatus.set('cancelling');
    render(<GenerateBar />);
    const btn = screen.getByTestId('cancel-button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe('Cancelling…');
  });

  it('shows run cancelled in the status line and restores Generate after cancel', () => {
    mathSlice().genStatus.set('cancelled');
    render(<GenerateBar />);
    expect(screen.getByTestId('generate-status').textContent).toBe('run cancelled');
    expect((screen.getByTestId('generate-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables generate and shows the locked chip when all three sections are locked', () => {
    mathSlice().locks.set({ reels: true, paytable: true, bonus: true });
    render(<GenerateBar />);
    expect((screen.getByTestId('generate-button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('generate-locked-chip')).toBeTruthy();
  });

  it('does not show the locked chip when only some sections are locked', () => {
    mathSlice().locks.set({ reels: true, paytable: false, bonus: false });
    render(<GenerateBar />);
    expect(screen.queryByTestId('generate-locked-chip')).toBeNull();
  });

  it('disables generate when targetGap is set', () => {
    mathSlice().targetGap.set('Missing volatility value');
    render(<GenerateBar />);
    expect((screen.getByTestId('generate-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows generation progress text while tuning', () => {
    mathSlice().genStatus.set('tuning');
    mathSlice().genProgress.set({ generation: 3, maxGenerations: 40 });
    render(<GenerateBar />);
    expect(screen.getByTestId('generate-status').textContent).toBe('tuning gen 3/40');
  });

  it('renders genFailure in generate-error', () => {
    mathSlice().genFailure.set('tune crashed');
    render(<GenerateBar />);
    expect(screen.getByTestId('generate-error').textContent).toBe('tune crashed');
  });

  it('does not render generate-error when there is no failure', () => {
    render(<GenerateBar />);
    expect(screen.queryByTestId('generate-error')).toBeNull();
  });

  it('disables verify-button while verifyStatus is running', () => {
    mathSlice().verifyStatus.set('running');
    render(<GenerateBar />);
    expect((screen.getByTestId('verify-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('calls verifyMath when Verify only is clicked', () => {
    render(<GenerateBar />);
    fireEvent.click(screen.getByTestId('verify-button'));
    expect(verifyMath).toHaveBeenCalled();
  });
});

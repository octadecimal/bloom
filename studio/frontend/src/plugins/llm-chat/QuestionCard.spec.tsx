import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QuestionCard } from './QuestionCard';
import * as actions from './actions';

const open = {
  index: 2,
  type: 'question' as const,
  toolName: null,
  content: JSON.stringify({
    kind: 'question',
    question: 'Bonus trigger?',
    suggestions: ['3+ scatters', 'random multiplier'],
    allowFreeText: true,
    allowDelegate: true,
    aspect: 'bonus-features',
  }),
  status: 'running' as const,
};

describe('QuestionCard', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders the question and suggestion chips', () => {
    render(<QuestionCard runId="r1" step={open} />);
    expect(screen.getByText('Bonus trigger?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3+ scatters' })).toBeInTheDocument();
  });

  it('wires a suggestion click', () => {
    const spy = vi.spyOn(actions, 'resolveQuestion').mockReturnValue(undefined);
    render(<QuestionCard runId="r1" step={open} />);
    fireEvent.click(screen.getByRole('button', { name: '3+ scatters' }));
    expect(spy).toHaveBeenCalledWith('r1', { type: 'suggestion', value: '3+ scatters' });
  });

  it('wires "you decide"', () => {
    const spy = vi.spyOn(actions, 'resolveQuestion').mockReturnValue(undefined);
    render(<QuestionCard runId="r1" step={open} />);
    fireEvent.click(screen.getByRole('button', { name: /you decide/i }));
    expect(spy).toHaveBeenCalledWith('r1', { type: 'delegate' });
  });

  it('collapses to the answered state when resolved', () => {
    const answered = {
      ...open,
      status: 'complete' as const,
      content: JSON.stringify({
        kind: 'question',
        question: 'Bonus trigger?',
        answer: { type: 'suggestion', value: '3+ scatters' },
      }),
    };
    render(<QuestionCard runId="r1" step={answered} />);
    expect(screen.getByText(/3\+ scatters/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /you decide/i })).toBeNull();
  });

  it('ArrowDown then Enter selects the second suggestion', () => {
    const spy = vi.spyOn(actions, 'resolveQuestion').mockReturnValue(undefined);
    render(<QuestionCard runId="r1" step={open} />);
    const card = screen.getByTestId('question-card');
    fireEvent.keyDown(card, { key: 'ArrowDown' });
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(spy).toHaveBeenCalledWith('r1', { type: 'suggestion', value: 'random multiplier' });
  });

  it('Enter without moving selects the first (default-focused) suggestion', () => {
    const spy = vi.spyOn(actions, 'resolveQuestion').mockReturnValue(undefined);
    render(<QuestionCard runId="r1" step={open} />);
    fireEvent.keyDown(screen.getByTestId('question-card'), { key: 'Enter' });
    expect(spy).toHaveBeenCalledWith('r1', { type: 'suggestion', value: '3+ scatters' });
  });

  it('number key "1" selects the first suggestion', () => {
    const spy = vi.spyOn(actions, 'resolveQuestion').mockReturnValue(undefined);
    render(<QuestionCard runId="r1" step={open} />);
    fireEvent.keyDown(screen.getByTestId('question-card'), { key: '1' });
    expect(spy).toHaveBeenCalledWith('r1', { type: 'suggestion', value: '3+ scatters' });
  });

  it('number key "2" selects the second suggestion', () => {
    const spy = vi.spyOn(actions, 'resolveQuestion').mockReturnValue(undefined);
    render(<QuestionCard runId="r1" step={open} />);
    fireEvent.keyDown(screen.getByTestId('question-card'), { key: '2' });
    expect(spy).toHaveBeenCalledWith('r1', { type: 'suggestion', value: 'random multiplier' });
  });

  it('does not hijack number/arrow/Enter keys typed into the free-text input', () => {
    const spy = vi.spyOn(actions, 'resolveQuestion').mockReturnValue(undefined);
    render(<QuestionCard runId="r1" step={open} />);
    const input = screen.getByPlaceholderText(/type your own/i);
    fireEvent.keyDown(input, { key: '2' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    // No suggestion selection should have fired from typing in the input.
    expect(spy).not.toHaveBeenCalledWith('r1', { type: 'suggestion', value: 'random multiplier' });
    expect(spy).not.toHaveBeenCalledWith('r1', { type: 'suggestion', value: '3+ scatters' });
  });
});

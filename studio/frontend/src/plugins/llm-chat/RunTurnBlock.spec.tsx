import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { makeInitialState, chatSlice, LLM_CHAT_PLUGIN_ID, type IRun } from './state';
import { RunTurnBlock } from './RunTurnBlock';

const run = (over: Partial<IRun>): IRun => ({
  id: 'run1',
  roomId: 'r1',
  skillName: 'generate-sprite',
  status: 'running',
  steps: [],
  createdAt: 't',
  ...over,
});

beforeEach(() => {
  rootStore.plugins.set({ [LLM_CHAT_PLUGIN_ID]: makeInitialState('guest-0001', 'r1') });
});

describe('RunTurnBlock', () => {
  it('renders tool and final steps inside a grouped assistant turn', () => {
    chatSlice().runs.set([
      run({
        steps: [
          { index: 0, type: 'tool_call', toolName: 'generate_asset', content: '{}', status: 'complete' },
          { index: 1, type: 'final', toolName: null, content: 'Done.', status: 'running' },
        ],
      }),
    ]);
    render(<RunTurnBlock index={0} />);
    const block = screen.getByTestId('run-turn-run1');
    expect(block.getAttribute('data-role')).toBe('assistant');
    expect(screen.getByText(/generate_asset/)).toBeInTheDocument();
    expect(screen.getByText('Done.')).toBeInTheDocument();
    expect(screen.getByTestId('run-step-0')).toBeInTheDocument();
    expect(screen.getByTestId('run-step-1')).toBeInTheDocument();
  });

  it('renders an approval step as the approval card', () => {
    chatSlice().runs.set([
      run({
        steps: [{ index: 0, type: 'approval', toolName: null, content: JSON.stringify({ tool: 'delete_asset', args: {}, label: "This can't be undone" }), status: 'running' }],
      }),
    ]);
    render(<RunTurnBlock index={0} />);
    expect(screen.getByTestId('approval-card')).toBeInTheDocument();
  });

  it('shows an "ai" avatar chip for the turn', () => {
    chatSlice().runs.set([run({ steps: [{ index: 0, type: 'final', toolName: null, content: 'Hi', status: 'complete' }] })]);
    render(<RunTurnBlock index={0} />);
    const chip = screen.getByTestId('run-turn-run1').querySelector('[aria-hidden]') as HTMLElement;
    expect(chip.textContent).toBe('ai');
  });
});

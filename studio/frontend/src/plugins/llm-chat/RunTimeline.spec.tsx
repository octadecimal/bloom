import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { makeInitialState, chatSlice, LLM_CHAT_PLUGIN_ID } from './state';
import { RunTimeline } from './RunTimeline';

beforeEach(() => {
  rootStore.plugins.set({ [LLM_CHAT_PLUGIN_ID]: makeInitialState('guest-0001', 'r1') });
});

it('renders tool and final steps for the active run', () => {
  chatSlice().runs.set([
    {
      id: 'run1',
      roomId: 'r1',
      skillName: 'generate-sprite',
      status: 'running',
      steps: [
        { index: 0, type: 'tool_call', toolName: 'generate_asset', content: '{...}', status: 'complete' },
        { index: 1, type: 'final', toolName: null, content: 'Done.', status: 'running' },
      ],
    },
  ]);
  render(<RunTimeline />);
  expect(screen.getByTestId('run-timeline')).toBeInTheDocument();
  expect(screen.getByText(/generate_asset/)).toBeInTheDocument();
  expect(screen.getByText('Done.')).toBeInTheDocument();
});

describe('RunTimeline step rendering', () => {
  it('shows a tool_result step with the tool name', () => {
    chatSlice().runs.set([
      {
        id: 'run2',
        roomId: 'r1',
        skillName: 'test-skill',
        status: 'running',
        steps: [{ index: 0, type: 'tool_result', toolName: 'read_file', content: 'file content', status: 'complete' }],
      },
    ]);
    render(<RunTimeline />);
    expect(screen.getByText(/read_file/)).toBeInTheDocument();
  });

  it('shows a thinking step as text content', () => {
    chatSlice().runs.set([
      {
        id: 'run3',
        roomId: 'r1',
        skillName: 'test-skill',
        status: 'running',
        steps: [{ index: 0, type: 'thinking', toolName: null, content: 'Thinking about this…', status: 'running' }],
      },
    ]);
    render(<RunTimeline />);
    expect(screen.getByText('Thinking about this…')).toBeInTheDocument();
  });

  it('assigns correct testid to each step', () => {
    chatSlice().runs.set([
      {
        id: 'run4',
        roomId: 'r1',
        skillName: 'test-skill',
        status: 'running',
        steps: [
          { index: 0, type: 'tool_call', toolName: 'my_tool', content: '{}', status: 'running' },
          { index: 1, type: 'final', toolName: null, content: 'Complete.', status: 'complete' },
        ],
      },
    ]);
    render(<RunTimeline />);
    expect(screen.getByTestId('run-step-0')).toBeInTheDocument();
    expect(screen.getByTestId('run-step-1')).toBeInTheDocument();
  });

  it('renders empty timeline when no runs exist', () => {
    render(<RunTimeline />);
    expect(screen.getByTestId('run-timeline')).toBeInTheDocument();
  });
});

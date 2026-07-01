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
  it('renders a completed tool as one borderless line with data-state=complete', () => {
    chatSlice().runs.set([
      run({
        steps: [
          { index: 0, type: 'tool_call', toolName: 'generate_asset', content: '{}', status: 'complete' },
          { index: 1, type: 'tool_result', toolName: 'generate_asset', content: 'ok', status: 'complete' },
          { index: 2, type: 'final', toolName: null, content: 'Done.', status: 'running' },
        ],
      }),
    ]);
    render(<RunTurnBlock index={0} />);
    // The two tool steps collapse into ONE line keyed by the call index.
    const tool = screen.getByTestId('run-step-0');
    expect(tool.getAttribute('data-state')).toBe('complete');
    expect(tool.textContent).toContain('generate_asset');
    expect(tool.className).not.toContain('border'); // borderless
    // No separate tool-result line is rendered.
    expect(screen.queryByTestId('run-step-1')).toBeNull();
    // The final step still renders as text.
    expect(screen.getByText('Done.')).toBeInTheDocument();
  });

  it('marks a tool with no result yet as data-state=running', () => {
    chatSlice().runs.set([run({ steps: [{ index: 0, type: 'tool_call', toolName: 'generate_asset', content: '{}', status: 'complete' }] })]);
    render(<RunTurnBlock index={0} />);
    expect(screen.getByTestId('run-step-0').getAttribute('data-state')).toBe('running');
  });

  it('renders the tool_result content as a muted output line under the tool name', () => {
    const summary = 'Composed 2 element(s)\n- art: Scene reads as a premium slot.';
    chatSlice().runs.set([
      run({
        steps: [
          { index: 0, type: 'tool_call', toolName: 'compose_scene', content: '{}', status: 'complete' },
          { index: 1, type: 'tool_result', toolName: 'compose_scene', content: summary, status: 'complete' },
        ],
      }),
    ]);
    render(<RunTurnBlock index={0} />);
    const tool = screen.getByTestId('run-step-0');
    expect(tool.textContent).toContain('compose_scene');
    expect(screen.getByTestId('run-step-output-0').textContent).toContain('Scene reads as a premium slot');
  });

  it('caps the output line height and makes it scrollable for verbose tool output', () => {
    const verbose = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    chatSlice().runs.set([
      run({
        steps: [
          { index: 0, type: 'tool_call', toolName: 'read_scene', content: '{}', status: 'complete' },
          { index: 1, type: 'tool_result', toolName: 'read_scene', content: verbose, status: 'complete' },
        ],
      }),
    ]);
    render(<RunTurnBlock index={0} />);
    const output = screen.getByTestId('run-step-output-0');
    expect(output.className).toMatch(/max-h-\d/);
    expect(output.className).toContain('overflow-y-auto');
    // Text stays in the DOM (scroll, not truncate) so downstream text assertions still pass.
    expect(output.textContent).toContain('line 0');
    expect(output.textContent).toContain('line 39');
  });

  it('renders no output line when the tool has no result content', () => {
    chatSlice().runs.set([
      run({
        steps: [
          { index: 0, type: 'tool_call', toolName: 'generate_asset', content: '{}', status: 'complete' },
          { index: 1, type: 'tool_result', toolName: 'generate_asset', content: '', status: 'complete' },
        ],
      }),
    ]);
    render(<RunTurnBlock index={0} />);
    expect(screen.queryByTestId('run-step-output-0')).toBeNull();
  });

  it('marks an errored tool as data-state=error', () => {
    chatSlice().runs.set([
      run({
        steps: [
          { index: 0, type: 'tool_call', toolName: 'delete_asset', content: '{}', status: 'complete' },
          { index: 1, type: 'tool_result', toolName: 'delete_asset', content: 'boom', status: 'error' },
        ],
      }),
    ]);
    render(<RunTurnBlock index={0} />);
    const tool = screen.getByTestId('run-step-0');
    expect(tool.getAttribute('data-state')).toBe('error');
    expect(tool.className).toContain('text-destructive');
  });

  it('gives an errored tool output line the destructive tone', () => {
    chatSlice().runs.set([
      run({
        steps: [
          { index: 0, type: 'tool_call', toolName: 'delete_asset', content: '{}', status: 'complete' },
          { index: 1, type: 'tool_result', toolName: 'delete_asset', content: 'boom', status: 'error' },
        ],
      }),
    ]);
    render(<RunTurnBlock index={0} />);
    const output = screen.getByTestId('run-step-output-0');
    expect(output.className).toContain('text-destructive');
    expect(output.className).not.toContain('text-muted-foreground');
  });

  it('keeps a non-errored tool output line muted', () => {
    chatSlice().runs.set([
      run({
        steps: [
          { index: 0, type: 'tool_call', toolName: 'compose_scene', content: '{}', status: 'complete' },
          { index: 1, type: 'tool_result', toolName: 'compose_scene', content: 'ok', status: 'complete' },
        ],
      }),
    ]);
    render(<RunTurnBlock index={0} />);
    const output = screen.getByTestId('run-step-output-0');
    expect(output.className).toContain('text-muted-foreground');
    expect(output.className).not.toContain('text-destructive');
  });

  it('renders an approval step as the approval card', () => {
    chatSlice().runs.set([
      run({
        steps: [
          {
            index: 0,
            type: 'approval',
            toolName: null,
            content: JSON.stringify({ tool: 'delete_asset', args: {}, label: "This can't be undone" }),
            status: 'running',
          },
        ],
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

import { describe, it, expect } from 'vitest';
import { foldToolSteps } from './toolFold';
import type { IRunStep } from './state';

const step = (over: Partial<IRunStep>): IRunStep => ({
  index: 0,
  type: 'tool_call',
  toolName: null,
  content: '',
  status: 'complete',
  ...over,
});

describe('foldToolSteps', () => {
  it('pairs an adjacent tool_call + tool_result into one complete tool entry', () => {
    const out = foldToolSteps([
      step({ index: 0, type: 'tool_call', toolName: 'generate_asset', status: 'complete' }),
      step({ index: 1, type: 'tool_result', toolName: 'generate_asset', status: 'complete' }),
    ]);
    expect(out).toEqual([{ kind: 'tool', callIndex: 0, toolName: 'generate_asset', status: 'complete' }]);
  });

  it('treats a lone tool_call (no result yet) as running', () => {
    const out = foldToolSteps([step({ index: 0, type: 'tool_call', toolName: 'generate_asset', status: 'complete' })]);
    expect(out).toEqual([{ kind: 'tool', callIndex: 0, toolName: 'generate_asset', status: 'running' }]);
  });

  it('propagates error from the result', () => {
    const out = foldToolSteps([
      step({ index: 0, type: 'tool_call', toolName: 'delete_asset', status: 'complete' }),
      step({ index: 1, type: 'tool_result', toolName: 'delete_asset', status: 'error' }),
    ]);
    expect(out[0]).toMatchObject({ kind: 'tool', status: 'error' });
  });

  it('propagates error from the call even before a result', () => {
    const out = foldToolSteps([step({ index: 0, type: 'tool_call', toolName: 'x', status: 'error' })]);
    expect(out[0]).toMatchObject({ kind: 'tool', status: 'error' });
  });

  it('passes thinking/final steps through untouched, in order', () => {
    const thinking = step({ index: 0, type: 'thinking', toolName: null, content: 'hmm', status: 'complete' });
    const final = step({ index: 1, type: 'final', toolName: null, content: 'done', status: 'complete' });
    const out = foldToolSteps([thinking, final]);
    expect(out).toEqual([
      { kind: 'passthrough', step: thinking },
      { kind: 'passthrough', step: final },
    ]);
  });

  it('folds two separate same-named call/result pairs into two tool entries', () => {
    const out = foldToolSteps([
      step({ index: 0, type: 'tool_call', toolName: 'gen', status: 'complete' }),
      step({ index: 1, type: 'tool_result', toolName: 'gen', status: 'complete' }),
      step({ index: 2, type: 'tool_call', toolName: 'gen', status: 'complete' }),
      step({ index: 3, type: 'tool_result', toolName: 'gen', status: 'complete' }),
    ]);
    expect(out).toEqual([
      { kind: 'tool', callIndex: 0, toolName: 'gen', status: 'complete' },
      { kind: 'tool', callIndex: 2, toolName: 'gen', status: 'complete' },
    ]);
  });

  it('renders an orphan tool_result defensively as its own entry', () => {
    const out = foldToolSteps([step({ index: 5, type: 'tool_result', toolName: 'gen', status: 'complete' })]);
    expect(out).toEqual([{ kind: 'tool', callIndex: 5, toolName: 'gen', status: 'complete' }]);
  });

  it('keeps a tool entry interleaved with passthrough steps in source order', () => {
    const thinking = step({ index: 0, type: 'thinking', toolName: null, content: 'plan', status: 'complete' });
    const out = foldToolSteps([
      thinking,
      step({ index: 1, type: 'tool_call', toolName: 'gen', status: 'complete' }),
      step({ index: 2, type: 'tool_result', toolName: 'gen', status: 'complete' }),
      step({ index: 3, type: 'final', toolName: null, content: 'ok', status: 'complete' }),
    ]);
    expect(out.map((e) => e.kind)).toEqual(['passthrough', 'tool', 'passthrough']);
    expect(out[1]).toMatchObject({ kind: 'tool', callIndex: 1 });
  });
});

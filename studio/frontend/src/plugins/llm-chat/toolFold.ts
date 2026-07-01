import type { IRunStep } from './state';

export type IRenderStep =
  | { kind: 'passthrough'; step: IRunStep }
  | { kind: 'tool'; callIndex: number; toolName: string | null; status: IRunStep['status']; output: string | null };

type IToolEntry = Extract<IRenderStep, { kind: 'tool' }>;

/**
 * Fold each tool_call (+ its later tool_result) into one merged tool entry, so a
 * tool renders as a single line instead of two cards. Non-tool steps pass
 * through untouched in source order. Pairing matches a tool_result to the
 * earliest still-unmatched tool_call with the same name (in this sequential
 * runner there is only ever one open call, so ordering is unambiguous).
 */
export function foldToolSteps(steps: readonly IRunStep[]): IRenderStep[] {
  const out: IRenderStep[] = [];
  const openCalls: IToolEntry[] = []; // unmatched tool_call entries already pushed to `out`

  for (const step of steps) {
    if (step.type === 'tool_call') {
      const entry: IToolEntry = {
        kind: 'tool',
        callIndex: step.index,
        toolName: step.toolName,
        status: step.status === 'error' ? 'error' : 'running',
        output: null,
      };
      out.push(entry);
      openCalls.push(entry);
    } else if (step.type === 'tool_result') {
      const matchAt = openCalls.findIndex((c) => c.toolName === step.toolName);
      if (matchAt === -1) {
        out.push({ kind: 'tool', callIndex: step.index, toolName: step.toolName, status: step.status, output: step.content });
      } else {
        const entry = openCalls[matchAt];
        openCalls.splice(matchAt, 1);
        entry.status = entry.status === 'error' || step.status === 'error' ? 'error' : step.status;
        entry.output = step.content;
      }
    } else {
      out.push({ kind: 'passthrough', step });
    }
  }

  return out;
}

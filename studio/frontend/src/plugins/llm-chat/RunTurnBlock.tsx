import { memo } from 'react';
import { Loader2, Check, X } from 'lucide-react';
import { llmChatHooks } from './state';
import type { IRunStep } from './state';
import { ApprovalCard } from './ApprovalCard';
import { QuestionCard } from './QuestionCard';
import { bumpRenderCount } from '../../app/renderCount';
import { foldToolSteps, type IRenderStep } from './toolFold';
import { Markdown } from '@/components/ui/Markdown';

type IReadonlyRunStep = Readonly<IRunStep>;

function ToolLine({ callIndex, toolName, status }: { callIndex: number; toolName: string | null; status: IRunStep['status'] }) {
  const isRunning = status === 'running';
  const isError = status === 'error';
  return (
    <div
      data-testid={`run-step-${callIndex}`}
      data-state={status}
      className={`flex items-center gap-1.5 text-xs ${isError ? 'text-destructive' : 'text-muted-foreground'}`}
    >
      {isRunning ? (
        <Loader2 aria-label="running" className="h-3 w-3 flex-none animate-spin text-accent-text" />
      ) : isError ? (
        <X aria-hidden className="h-3 w-3 flex-none" />
      ) : (
        <Check aria-hidden className="h-3 w-3 flex-none" />
      )}
      <span className={isRunning ? 'tool-shimmer' : undefined}>{toolName ?? 'tool'}</span>
    </div>
  );
}

function RunStepCard({ step, index, runId }: { step: IReadonlyRunStep; index: number; runId: string }) {
  if (step.type === 'approval') {
    return <ApprovalCard runId={runId} step={step as IRunStep} />;
  }
  if (step.type === 'question') {
    return <QuestionCard runId={runId} step={step as IRunStep} />;
  }
  const isRunning = step.status === 'running';
  // thinking | final — render as streamed text (assistant-bubble typography)
  return (
    <div data-testid={`run-step-${index}`} className="text-[13px] leading-snug text-foreground">
      <Markdown source={step.content} />
      {isRunning && (
        <span data-testid={`run-step-caret-${index}`} className="ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 rounded-sm bg-primary align-baseline" />
      )}
    </div>
  );
}

// A skill run renders as ONE assistant turn: AI avatar + accent rail (mirroring
// the assistant chat bubble) wrapping the run's steps. Subscribes only to its own
// run node, so a run_step_token re-renders this block alone. Wrapped in memo so a
// parent (MessageList) re-render from an unrelated append does not re-render it;
// its own run-node subscription still drives re-renders while its steps stream.
export const RunTurnBlock = memo(function RunTurnBlock({ index }: { index: number }) {
  const s = llmChatHooks.usePluginState();
  const r = s.runs[index];
  bumpRenderCount('RunTurnBlock');

  const id = r.id.get();
  const steps = r.steps.get();

  return (
    <li data-testid={`run-turn-${id}`} data-role="assistant" className="flex gap-2 rounded-r border-l-2 border-primary/50 bg-primary/[0.04] pl-2">
      <div
        aria-hidden
        className="mt-px flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] border border-primary/30 bg-raised font-mono text-[9px] text-accent-text"
      >
        ai
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        {foldToolSteps(steps).map((entry: IRenderStep) =>
          entry.kind === 'tool' ? (
            <ToolLine key={`t:${entry.callIndex}`} callIndex={entry.callIndex} toolName={entry.toolName} status={entry.status} />
          ) : (
            <RunStepCard key={`s:${entry.step.index}`} step={entry.step} index={entry.step.index} runId={id} />
          ),
        )}
      </div>
    </li>
  );
});

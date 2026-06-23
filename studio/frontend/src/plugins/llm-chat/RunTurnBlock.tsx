import { llmChatHooks } from './state';
import type { IRunStep } from './state';
import { ApprovalCard } from './ApprovalCard';
import { bumpRenderCount } from '../../app/renderCount';

type IReadonlyRunStep = Readonly<IRunStep>;

function RunStepCard({ step, index, runId }: { step: IReadonlyRunStep; index: number; runId: string }) {
  if (step.type === 'approval') {
    return <ApprovalCard runId={runId} step={step as IRunStep} />;
  }
  const isToolStep = step.type === 'tool_call' || step.type === 'tool_result';
  const isError = step.status === 'error';
  const isRunning = step.status === 'running';

  if (isToolStep) {
    return (
      <div
        data-testid={`run-step-${index}`}
        className={`rounded-md border p-2 ${isError ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border bg-surface'}`}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground uppercase">{step.type === 'tool_call' ? 'tool call' : 'tool result'}</span>
          {isRunning && <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" aria-label="running" />}
        </div>
        <div className="mt-1 text-sm text-foreground">{step.toolName}</div>
      </div>
    );
  }

  // thinking | final — render as streamed text (assistant-bubble typography)
  return (
    <div data-testid={`run-step-${index}`} className="text-[13px] leading-snug text-foreground">
      {step.content}
      {isRunning && (
        <span data-testid={`run-step-caret-${index}`} className="ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 rounded-sm bg-primary align-baseline" />
      )}
    </div>
  );
}

// A skill run renders as ONE assistant turn: AI avatar + accent rail (mirroring
// the assistant chat bubble) wrapping the run's steps. Subscribes only to its own
// run node, so a run_step_token re-renders this block alone.
export function RunTurnBlock({ index }: { index: number }) {
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
        {steps.map((step) => (
          <RunStepCard key={step.index} step={step} index={step.index} runId={id} />
        ))}
      </div>
    </li>
  );
}

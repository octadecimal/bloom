import { llmChatHooks } from './state';
import type { IRunStep } from './state';

// Readonly wrappers for hookstate-returned objects
type IReadonlyRunStep = Readonly<IRunStep>;
type IReadonlyRun = {
  readonly id: string;
  readonly steps: readonly IReadonlyRunStep[];
};

function RunStepCard({ step, index }: { step: IReadonlyRunStep; index: number }) {
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

  // thinking | final — render as streamed text
  return (
    <div data-testid={`run-step-${index}`} className="text-sm text-foreground">
      {step.content}
      {isRunning && (
        <span data-testid={`run-step-caret-${index}`} className="ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 rounded-sm bg-primary align-baseline" />
      )}
    </div>
  );
}

function RunStepList({ run }: { run: IReadonlyRun }) {
  return (
    <div className="flex flex-col gap-2">
      {run.steps.map((step) => (
        <RunStepCard key={step.index} step={step} index={step.index} />
      ))}
    </div>
  );
}

export function RunTimeline() {
  const s = llmChatHooks.usePluginState();
  const runs = s.runs.get();

  return (
    <div data-testid="run-timeline" className="flex flex-col gap-3 bg-surface p-2">
      {runs.map((run) => (
        <RunStepList key={run.id} run={run} />
      ))}
    </div>
  );
}

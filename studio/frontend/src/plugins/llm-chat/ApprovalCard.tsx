import { useEffect, useRef } from 'react';
import type { IRunStep } from './state';
import { parseApprovalAction } from './state';
import { resolveApproval } from './actions';
import { Button } from '../../components/ui/button';

export function ApprovalCard({ runId, step }: { runId: string; step: IRunStep }) {
  const resolved = step.status === 'complete';
  const action = parseApprovalAction(step);
  const label = action?.label ?? 'Approve this action?';
  const decision = resolved ? safeDecision(step.content) : null;

  // Focus the card while pending so Enter resolves it without a click; Enter on the
  // card approves (the primary action). Buttons keep their own click/Enter semantics.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!resolved) ref.current?.focus();
  }, [resolved]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (resolved) return;
    if ((e.target as HTMLElement)?.tagName === 'BUTTON') return;
    if (e.key === 'Enter') {
      e.preventDefault();
      resolveApproval(runId, 'approve');
    }
  };

  return (
    <div
      ref={ref}
      tabIndex={resolved ? undefined : 0}
      onKeyDown={onKeyDown}
      data-testid="approval-card"
      className="rounded-md border bg-surface p-2 outline-none"
    >
      <p className="text-sm text-foreground">{label}</p>
      <div className="mt-2 flex gap-2">
        <Button disabled={resolved} onClick={() => resolveApproval(runId, 'approve')}>
          Approve
        </Button>
        <Button variant="ghost" disabled={resolved} onClick={() => resolveApproval(runId, 'deny')}>
          Deny
        </Button>
      </div>
      {resolved && <p className="mt-1 text-xs text-muted-foreground">{decision === 'approve' ? 'Approved' : 'Denied'}</p>}
    </div>
  );
}

function safeDecision(content: string): string | null {
  try {
    return (JSON.parse(content) as { decision?: string }).decision ?? null;
  } catch {
    return null;
  }
}

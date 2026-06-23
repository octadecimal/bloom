import type { IRunStep } from './state';
import { parseApprovalAction } from './state';
import { resolveApproval } from './actions';
import { Button } from '../../components/ui/button';

export function ApprovalCard({ runId, step }: { runId: string; step: IRunStep }) {
  const resolved = step.status === 'complete';
  const action = parseApprovalAction(step);
  const label = action?.label ?? 'Approve this action?';
  const decision = resolved ? safeDecision(step.content) : null;
  return (
    <div data-testid="approval-card" className="rounded-md border bg-surface p-2">
      <p className="text-sm text-foreground">{label}</p>
      <div className="mt-2 flex gap-2">
        <Button disabled={resolved} onClick={() => resolveApproval(runId, 'approve')}>
          Approve
        </Button>
        <Button variant="ghost" disabled={resolved} onClick={() => resolveApproval(runId, 'deny')}>
          Deny
        </Button>
      </div>
      {resolved && (
        <p className="mt-1 text-xs text-muted-foreground">
          {decision === 'approve' ? 'Approved' : 'Denied'}
        </p>
      )}
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

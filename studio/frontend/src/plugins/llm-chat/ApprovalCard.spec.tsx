import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ApprovalCard } from './ApprovalCard';
import * as actions from './actions';

const pending = {
  index: 1,
  type: 'approval' as const,
  toolName: null,
  content: JSON.stringify({
    tool: 'delete_asset',
    args: { asset_id: 'a1' },
    label: "Delete 'knight' — can't be undone.",
  }),
  status: 'running' as const,
};

describe('ApprovalCard', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('shows the label and wires Approve', () => {
    const spy = vi.spyOn(actions, 'resolveApproval').mockReturnValue(undefined);
    render(<ApprovalCard runId="run1" step={pending} />);
    expect(screen.getByText(/can't be undone/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect(spy).toHaveBeenCalledWith('run1', 'approve');
  });

  it('wires Deny', () => {
    const spy = vi.spyOn(actions, 'resolveApproval').mockReturnValue(undefined);
    render(<ApprovalCard runId="run1" step={pending} />);
    fireEvent.click(screen.getByRole('button', { name: /deny/i }));
    expect(spy).toHaveBeenCalledWith('run1', 'deny');
  });

  it('disables buttons after resolution', () => {
    const resolved = {
      ...pending,
      status: 'complete' as const,
      content: JSON.stringify({ decision: 'approve' }),
    };
    render(<ApprovalCard runId="run1" step={resolved} />);
    expect(screen.getByRole('button', { name: /approve/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /deny/i })).toBeDisabled();
  });

  it('shows "Approved" outcome text when resolved with approve', () => {
    const resolved = {
      ...pending,
      status: 'complete' as const,
      content: JSON.stringify({ decision: 'approve' }),
    };
    render(<ApprovalCard runId="run1" step={resolved} />);
    expect(screen.getByText('Approved')).toBeInTheDocument();
  });

  it('shows "Denied" outcome text when resolved with deny', () => {
    const resolved = {
      ...pending,
      status: 'complete' as const,
      content: JSON.stringify({ decision: 'deny' }),
    };
    render(<ApprovalCard runId="run1" step={resolved} />);
    expect(screen.getByText('Denied')).toBeInTheDocument();
  });
});

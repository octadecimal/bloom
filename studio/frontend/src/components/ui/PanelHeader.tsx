import * as React from 'react';
import { cn } from '@/lib/utils';

export interface IPanelHeaderProps {
  label: string;
  right?: React.ReactNode;
  className?: string;
}

export function PanelHeader({ label, right, className }: IPanelHeaderProps) {
  return (
    <div data-testid="panel-header" className={cn('flex items-center gap-2 border-b border-border px-2.5 py-1.5', className)}>
      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
      {right && <span className="ml-auto text-[11px] text-muted-foreground">{right}</span>}
    </div>
  );
}

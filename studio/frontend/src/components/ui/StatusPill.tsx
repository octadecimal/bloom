import * as React from 'react';
import { cn } from '@/lib/utils';

export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger';

export interface IStatusPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: StatusTone;
}

const dotClass: Record<StatusTone, string> = {
  neutral: 'bg-muted-foreground',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
};

export function StatusPill({ tone = 'neutral', children, className, ...rest }: IStatusPillProps) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full bg-raised px-2 py-0.5 text-[11px] text-muted-foreground', className)} {...rest}>
      <span className={cn('h-1.5 w-1.5 rounded-full', dotClass[tone])} />
      {children}
    </span>
  );
}

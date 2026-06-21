import * as React from 'react';
import { cn } from '@/lib/utils';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'h-9 rounded-md border border-input bg-background px-3 py-1 text-sm outline-none',
          'focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
          className,
        )}
        {...props}
      />
    );
  },
);

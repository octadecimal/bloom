import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva('inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors disabled:opacity-50', {
  variants: {
    variant: {
      default: 'bg-primary text-primary-foreground hover:opacity-90',
      outline: 'border border-border bg-transparent hover:bg-primary/10',
      ghost: 'bg-transparent hover:bg-accent',
      destructive: 'bg-destructive text-destructive-foreground hover:opacity-90',
    },
    size: { default: 'h-9 px-4 py-2', sm: 'h-8 px-3 text-xs', icon: 'h-9 w-9' },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});

export interface IButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: IButtonProps) {
  return <button className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

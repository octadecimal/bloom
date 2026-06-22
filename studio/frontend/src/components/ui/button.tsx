import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary-hover',
        outline: 'border border-border bg-transparent hover:bg-raised-hover',
        ghost: 'bg-transparent hover:bg-accent',
        destructive: 'bg-destructive text-destructive-foreground hover:opacity-90',
        accentOutline: 'border border-primary/45 bg-transparent text-accent-text hover:bg-primary/10',
      },
      size: { default: 'h-7 px-3 text-[13px]', sm: 'h-6 px-2.5 text-xs', icon: 'h-7 w-7' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface IButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: IButtonProps) {
  return <button className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

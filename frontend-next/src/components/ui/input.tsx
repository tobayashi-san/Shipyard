import * as React from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        'flex h-8 min-w-0 w-full rounded-sm border border-input bg-background px-2.5 py-1 text-[13px] shadow-[inset_0_1px_1px_hsl(var(--foreground)/0.025)] transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground/80 focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/15 aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive/20 disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
);
Input.displayName = 'Input';

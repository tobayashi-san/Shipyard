import * as React from 'react';
import { cn } from '@/lib/utils';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'flex min-h-20 w-full rounded-sm border border-input bg-background px-2.5 py-1.5 text-[13px] leading-5 shadow-[inset_0_1px_1px_hsl(var(--foreground)/0.025)] transition-colors placeholder:text-muted-foreground/80 focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/15 aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive/20 disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
);
Textarea.displayName = 'Textarea';

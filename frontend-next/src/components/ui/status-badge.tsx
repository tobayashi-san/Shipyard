import * as React from 'react';
import { cn } from '@/lib/utils';

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'muted' | 'neutral';

const toneStyles: Record<StatusTone, string> = {
  success: '[background:hsl(var(--success)/0.12)] [border-color:hsl(var(--success)/0.26)] [color:hsl(var(--success))]',
  warning: '[background:hsl(var(--warning)/0.13)] [border-color:hsl(var(--warning)/0.28)] [color:hsl(var(--warning))]',
  danger:  '[background:hsl(var(--destructive)/0.12)] [border-color:hsl(var(--destructive)/0.28)] [color:hsl(var(--destructive))]',
  info:    '[background:hsl(var(--info)/0.12)] [border-color:hsl(var(--info)/0.28)] [color:hsl(var(--info))]',
  muted:   'bg-muted text-muted-foreground border-border',
  neutral: 'bg-secondary text-secondary-foreground border-border',
};

const dotColor: Record<StatusTone, string> = {
  success: '[background:hsl(var(--success))]',
  warning: '[background:hsl(var(--warning))]',
  danger:  '[background:hsl(var(--destructive))]',
  info:    '[background:hsl(var(--info))]',
  muted:   'bg-muted-foreground/40',
  neutral: 'bg-foreground/40',
};

export interface StatusBadgeProps {
  tone?: StatusTone;
  children: React.ReactNode;
  dot?: boolean;
  pulse?: boolean;
  className?: string;
}

export function StatusBadge({ tone = 'neutral', children, dot, pulse, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold leading-4',
        toneStyles[tone],
        className
      )}
    >
      {dot && (
        <span className={cn('h-1.5 w-1.5 rounded-full', dotColor[tone], pulse && 'pulse-dot')} />
      )}
      {children}
    </span>
  );
}

/**
 * Live indicator — small pulsing dot, no border.
 * Use inline before text like "Live" or with status names.
 */
export function LiveDot({ tone = 'success', className }: { tone?: StatusTone; className?: string }) {
  return (
    <span className={cn('relative inline-flex h-2 w-2', className)}>
      <span className={cn('absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping', dotColor[tone])} />
      <span className={cn('relative inline-flex h-2 w-2 rounded-full', dotColor[tone])} />
    </span>
  );
}

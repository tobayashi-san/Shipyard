import * as React from 'react';
import { cn } from '@/lib/utils';

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'muted' | 'neutral';

const toneStyles: Record<StatusTone, string> = {
  success: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
  warning: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20',
  danger:  'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20',
  info:    'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
  muted:   'bg-muted text-muted-foreground border-border',
  neutral: 'bg-secondary text-secondary-foreground border-border',
};

const dotColor: Record<StatusTone, string> = {
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger:  'bg-rose-500',
  info:    'bg-blue-500',
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
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
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

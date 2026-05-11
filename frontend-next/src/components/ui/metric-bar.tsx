import { cn } from '@/lib/utils';

export type MetricThresholdTone = 'success' | 'warning' | 'danger' | 'muted';

export function metricTone(pct: number | null | undefined, warningAt = 85, dangerAt = 95): MetricThresholdTone {
  if (pct == null) return 'muted';
  if (pct >= dangerAt) return 'danger';
  if (pct >= warningAt) return 'warning';
  return 'success';
}

const fillColor: Record<MetricThresholdTone, string> = {
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
  muted: 'bg-muted-foreground/30',
};

const textColor: Record<MetricThresholdTone, string> = {
  success: '',
  warning: 'text-amber-600 dark:text-amber-500',
  danger: 'text-red-600 dark:text-red-500',
  muted: 'text-muted-foreground',
};

export function metricTextClass(pct: number | null | undefined, warningAt = 85, dangerAt = 95) {
  return textColor[metricTone(pct, warningAt, dangerAt)];
}

/**
 * MetricBar — shared bar visualisation for CPU/RAM/Disk usage.
 * - `size`: visual height (xs ≈ 1px, sm ≈ 1.5px, md ≈ 2.5px)
 * - `showTicks`: render subtle tick marks at 80% and 95%
 */
export function MetricBar({
  pct,
  size = 'sm',
  showTicks,
  className,
  warningAt = 85,
  dangerAt = 95,
}: {
  pct: number | null | undefined;
  size?: 'xs' | 'sm' | 'md';
  showTicks?: boolean;
  className?: string;
  warningAt?: number;
  dangerAt?: number;
}) {
  const tone = metricTone(pct, warningAt, dangerAt);
  const safe = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const heightCls = size === 'xs' ? 'h-1' : size === 'md' ? 'h-2.5' : 'h-1.5';

  return (
    <div className={cn('relative w-full overflow-hidden rounded-full bg-muted', heightCls, className)}>
      {pct != null && (
        <div
          className={cn('h-full rounded-full transition-[width] duration-300 ease-out', fillColor[tone])}
          style={{ width: `${safe}%` }}
        />
      )}
      {showTicks && (
        <>
          <span className="pointer-events-none absolute inset-y-0 w-px bg-border" style={{ left: `${Math.max(0, Math.min(100, warningAt))}%` }} />
          <span className="pointer-events-none absolute inset-y-0 w-px bg-border" style={{ left: `${Math.max(0, Math.min(100, dangerAt))}%` }} />
        </>
      )}
    </div>
  );
}

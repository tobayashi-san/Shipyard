import * as React from 'react';
import { cn } from '@/lib/utils';

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('skeleton h-4 w-full', className)} {...props} />;
}

/**
 * SkeletonRow — placeholder for table rows / list items.
 */
export function SkeletonRow({ cols = 4 }: { cols?: number }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 border-b last:border-0">
      {Array.from({ length: cols }).map((_, i) => (
        <Skeleton key={i} className={cn('h-3', i === 0 ? 'w-1/4' : 'flex-1')} />
      ))}
    </div>
  );
}

/**
 * SkeletonCard — placeholder card body.
 */
export function SkeletonCard() {
  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}

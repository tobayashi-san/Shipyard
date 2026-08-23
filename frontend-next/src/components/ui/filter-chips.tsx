import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ActiveFilterChip {
  id: string;
  label: string;
  onRemove: () => void;
}

export function ActiveFilterChips({
  filters,
  onClear,
  clearLabel = 'Clear all',
  className,
}: {
  filters: ActiveFilterChip[];
  onClear: () => void;
  clearLabel?: string;
  className?: string;
}) {
  if (filters.length === 0) return null;

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5 rounded-[3px] border border-border/70 bg-muted/10 px-3 py-2', className)} aria-label="Active filters">
      <span className="mr-1 text-[11px] font-semibold text-muted-foreground">Active filters</span>
      {filters.map((filter) => (
        <button
          key={filter.id}
          type="button"
          onClick={filter.onRemove}
          className="inline-flex h-6 max-w-full items-center gap-1 rounded-full border border-border-strong/70 bg-background px-2 text-[11px] font-medium text-foreground transition-colors hover:bg-accent"
          title={`Remove filter: ${filter.label}`}
        >
          <span className="truncate">{filter.label}</span>
          <X className="h-3 w-3 shrink-0 text-muted-foreground" />
        </button>
      ))}
      <Button type="button" variant="ghost" size="sm" className="ml-auto h-6 px-2 text-[11px]" onClick={onClear}>
        {clearLabel}
      </Button>
    </div>
  );
}

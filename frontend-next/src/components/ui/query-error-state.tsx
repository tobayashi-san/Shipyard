import { AlertCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface QueryErrorStateProps {
  error?: unknown;
  onRetry?: () => void;
  title?: string;
  className?: string;
  compact?: boolean;
}

/** A consistent, non-destructive failure state for API-backed console panels. */
export function QueryErrorState({ error, onRetry, title = 'Data could not be loaded', className, compact = false }: QueryErrorStateProps) {
  const detail = error instanceof Error ? error.message : '';
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2.5 text-center', compact ? 'px-4 py-7' : 'px-5 py-12', className)} role="status">
      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-destructive/10 text-destructive"><AlertCircle className="h-4 w-4" /></div>
      <div>
        <p className="text-sm font-medium">{title}</p>
        {detail && <p className="mt-0.5 max-w-md text-xs text-muted-foreground">{detail}</p>}
      </div>
      {onRetry && <Button variant="outline" size="sm" onClick={onRetry}><RefreshCw className="h-3.5 w-3.5" /> Try again</Button>}
    </div>
  );
}

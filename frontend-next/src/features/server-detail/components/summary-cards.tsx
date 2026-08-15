import type { ReactNode } from 'react';
import { Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { showToast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { MetricBar } from '@/components/ui/metric-bar';

export function ThresholdBar({ pct, warningAt }: { pct: number | null; warningAt?: number }) {
  return <MetricBar pct={pct} size="md" showTicks warningAt={warningAt} />;
}

export function StatCard({ icon, label, value, hint, variant, compact = false }: {
  icon: ReactNode; label: string; value: string; hint?: string;
  variant?: 'ok' | 'warning' | 'error' | 'muted';
  compact?: boolean;
}) {
  const valColor = variant === 'ok' ? 'text-success' : variant === 'warning' ? 'text-warning' : variant === 'error' ? 'text-destructive' : '';
  if (compact) {
    return (
      <div className="flex min-h-14 min-w-0 items-center gap-2 bg-card px-3 py-2">
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1 truncate text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className={`shrink-0 truncate text-base font-semibold ${valColor}`}>{value}</span>
        {hint && <span className="sr-only">{hint}</span>}
      </div>
    );
  }
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-3">
        <div className={`flex h-9 w-9 items-center justify-center rounded-md ${variant === 'ok' ? 'bg-success/10 text-success' : variant === 'warning' ? 'bg-warning/10 text-warning' : variant === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'}`}>{icon}</div>
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
          <div className={`truncate font-semibold ${valColor}`}>{value}</div>
          {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
        </div>
      </CardContent>
    </Card>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation();
  return (
    <Button variant="ghost" size="icon" className="h-6 w-6"
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); showToast(`${label} ${t('common.copied')}`, 'success'); }
        catch { showToast(t('common.error'), 'error'); }
      }}>
      <Copy className="h-3 w-3" />
    </Button>
  );
}

import { useState, useEffect } from 'react';
import { CheckCircle2, AlertTriangle, Info, XCircle, X } from 'lucide-react';
import { useToastStore, type ToastKind } from '@/lib/toast';
import { cn } from '@/lib/utils';

const ICONS: Record<ToastKind, React.ComponentType<{ className?: string }>> = {
  success: CheckCircle2,
  error:   XCircle,
  warning: AlertTriangle,
  info:    Info,
};

const KIND_ICON_COLOR: Record<ToastKind, string> = {
  success: 'text-emerald-500',
  error:   'text-rose-500',
  warning: 'text-amber-500',
  info:    'text-blue-500',
};

const MAX_VISIBLE = 3;

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  const [hovered, setHovered] = useState(false);

  // Show newest first; expanded on hover, collapsed otherwise
  const sorted = [...toasts].reverse();
  const visible = hovered ? sorted : sorted.slice(0, MAX_VISIBLE);

  return (
    <div
      aria-live="polite"
      className="fixed bottom-4 right-4 z-[100] w-[min(360px,calc(100%-2rem))]"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className={cn('relative', hovered ? 'space-y-2' : '')}>
        {visible.map((t, i) => {
          const Icon = ICONS[t.kind];
          // Stack effect when collapsed
          const stackedStyle: React.CSSProperties = hovered
            ? {}
            : {
                position: i === 0 ? 'relative' : 'absolute',
                top: 0,
                right: 0,
                left: 0,
                transform: i === 0 ? 'none' : `translateY(-${i * 8}px) scale(${1 - i * 0.04})`,
                opacity: 1 - i * 0.15,
                zIndex: MAX_VISIBLE - i,
                pointerEvents: i === 0 ? 'auto' : 'none',
              };
          return (
            <div
              key={t.id}
              style={stackedStyle}
              className={cn(
                'pointer-events-auto relative flex items-start gap-3 rounded-lg border bg-popover/95 backdrop-blur-md p-3 shadow-pop',
                'animate-slide-up transition-all duration-200'
              )}
              role="status"
            >
              <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', KIND_ICON_COLOR[t.kind])} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium leading-tight">{t.message}</div>
                {t.description && (
                  <div className="mt-1 text-xs text-muted-foreground">{t.description}</div>
                )}
                {t.action && (
                  <button
                    onClick={() => { t.action!.onClick(); dismiss(t.id); }}
                    className="mt-2 rounded border border-strong bg-background px-2 py-0.5 text-xs font-medium hover:bg-accent"
                  >
                    {t.action.label}
                  </button>
                )}
              </div>
              <button
                onClick={() => dismiss(t.id)}
                className="-mr-1 -mt-0.5 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Dismiss"
              >
                <X className="h-3.5 w-3.5" />
              </button>
              <ProgressBar id={t.id} duration={t.duration ?? (t.kind === 'error' ? 6500 : 4000)} createdAt={t.createdAt} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProgressBar({ id, duration, createdAt }: { id: number; duration: number; createdAt: number }) {
  const [pct, setPct] = useState(100);
  useEffect(() => {
    if (duration <= 0) return;
    let raf: number;
    const tick = () => {
      const elapsed = Date.now() - createdAt;
      const remaining = Math.max(0, 100 - (elapsed / duration) * 100);
      setPct(remaining);
      if (remaining > 0) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [id, duration, createdAt]);
  return (
    <div className="absolute bottom-0 left-0 right-0 h-0.5 overflow-hidden rounded-b-lg">
      <div
        className="h-full bg-foreground/20 transition-[width]"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

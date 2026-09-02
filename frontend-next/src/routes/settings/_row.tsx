import { cn } from '@/lib/utils';

interface SettingsRowProps {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  align?: 'center' | 'start';
  noBorder?: boolean;
  className?: string;
  labelId?: string;
}

/**
 * Two-column settings row: left = label + hint, right = control(s).
 */
export function SettingsRow({ label, hint, children, align = 'center', noBorder, className, labelId }: SettingsRowProps) {
  return (
    <div
      className={cn(
        'grid grid-cols-1 gap-2.5 py-3.5 sm:grid-cols-[minmax(0,220px)_1fr] sm:gap-6',
        !noBorder && 'border-b border-border/60 last:border-b-0',
        align === 'start' ? 'sm:items-start' : 'sm:items-center',
        className
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5 text-sm">
        {label && <span id={labelId} className="font-medium text-foreground">{label}</span>}
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

interface SettingsSectionProps {
  title?: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

/** Card-like section that hosts a group of SettingsRow's. */
export function SettingsSection({ title, description, icon, headerRight, children, className }: SettingsSectionProps) {
  return (
    <section className={cn('rounded-[3px] border border-border-strong/80 bg-card text-card-foreground shadow-[0_1px_2px_hsl(var(--foreground)/0.045)]', className)}>
      {(title || description || headerRight) && (
        <header className="flex flex-wrap items-start gap-3 border-b border-border/60 px-4 py-3.5 sm:flex-nowrap">
          {icon && <div className="mt-0.5 text-muted-foreground">{icon}</div>}
          <div className="min-w-0 flex-1">
            {title && <h3 className="text-sm font-semibold">{title}</h3>}
            {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
          </div>
          {headerRight && <div className="flex flex-wrap items-center gap-2">{headerRight}</div>}
        </header>
      )}
      <div className="px-4">{children}</div>
    </section>
  );
}

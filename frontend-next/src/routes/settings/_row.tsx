import { cn } from '@/lib/utils';

interface SettingsRowProps {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  align?: 'center' | 'start';
  noBorder?: boolean;
  className?: string;
}

/**
 * Two-column settings row: left = label + hint, right = control(s).
 * Mirrors the legacy `.settings-row` layout from frontend/src/styles/*.
 */
export function SettingsRow({ label, hint, children, align = 'center', noBorder, className }: SettingsRowProps) {
  return (
    <div
      className={cn(
        'grid grid-cols-1 gap-3 py-4 sm:grid-cols-[minmax(0,220px)_1fr] sm:gap-6',
        !noBorder && 'border-b border-border/60 last:border-b-0',
        align === 'start' ? 'sm:items-start' : 'sm:items-center',
        className
      )}
    >
      <div className="flex flex-col gap-0.5 text-sm">
        {label && <span className="font-medium text-foreground">{label}</span>}
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

interface SettingsSectionProps {
  title?: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

/** Card-like section that hosts a group of SettingsRow's. */
export function SettingsSection({ title, description, icon, children, className }: SettingsSectionProps) {
  return (
    <section className={cn('rounded-lg border bg-card text-card-foreground shadow-sm', className)}>
      {(title || description) && (
        <header className="flex items-start gap-3 border-b border-border/60 px-5 py-4">
          {icon && <div className="mt-0.5 text-muted-foreground">{icon}</div>}
          <div className="min-w-0 flex-1">
            {title && <h3 className="text-sm font-semibold tracking-tight">{title}</h3>}
            {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
          </div>
        </header>
      )}
      <div className="px-5">{children}</div>
    </section>
  );
}

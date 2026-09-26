import { useState } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { CircleHelp } from 'lucide-react';
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
        <div className="flex items-center gap-1.5">
          {label && <span id={labelId} className="font-medium text-foreground">{label}</span>}
          {typeof hint === 'string' && <SettingHelp label={typeof label === 'string' ? label : 'setting'}>{hint}</SettingHelp>}
        </div>
        {hint && typeof hint !== 'string' && <div className="text-[13px] text-muted-foreground">{hint}</div>}
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
    <section className={cn('rounded-panel border border-border-strong/80 bg-card text-card-foreground ', className)}>
      {(title || description || headerRight) && (
        <header className="flex flex-wrap items-start gap-3 border-b border-border/60 px-4 py-3.5 sm:flex-nowrap">
          {icon && <div className="flex h-7 items-center text-muted-foreground">{icon}</div>}
          <div className="min-w-0 flex-1">
            <div className="flex min-h-7 items-center gap-1.5">
              {title && <h3 className="text-sm font-semibold">{title}</h3>}
              {typeof description === 'string' && <SettingHelp label={typeof title === 'string' ? title : 'section'}>{description}</SettingHelp>}
            </div>
            {description && typeof description !== 'string' && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
          </div>
          {headerRight && <div className="flex flex-wrap items-center gap-2">{headerRight}</div>}
        </header>
      )}
      <div className="px-4">{children}</div>
    </section>
  );
}

function SettingHelp({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return <Tooltip.Provider delayDuration={200}><Tooltip.Root open={open} onOpenChange={setOpen}>
    <Tooltip.Trigger asChild><button type="button" onClick={event => { event.preventDefault(); setOpen(true); }} aria-label={`Help: ${label}`} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><CircleHelp className="h-3.5 w-3.5" /></button></Tooltip.Trigger>
    <Tooltip.Portal><Tooltip.Content sideOffset={4} collisionPadding={8} className="z-[110] max-w-xs rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md">{children}</Tooltip.Content></Tooltip.Portal>
  </Tooltip.Root></Tooltip.Provider>;
}

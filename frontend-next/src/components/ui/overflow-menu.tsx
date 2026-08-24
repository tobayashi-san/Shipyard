import { useEffect, useRef, useState } from 'react';
import { ChevronDown, MoreVertical } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { Button } from './button';

// ─── OverflowMenu ─────────────────────────────────────────────
// Click-outside-aware popover triggered by a vertical "⋮" icon button.
// Use with <OverflowItem /> and <OverflowSep />.
export function OverflowMenu({
  children,
  width = 'w-56',
  title = 'Actions',
  trigger,
}: {
  children: React.ReactNode;
  width?: string;
  title?: string;
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('click', handler);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', handler);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <Button variant={trigger ? "outline" : "ghost"} size={trigger ? "sm" : "icon"} onClick={() => setOpen(!open)} title={title} aria-label={title} aria-haspopup="menu" aria-expanded={open}>
        {trigger || <MoreVertical className="h-4 w-4" />}
        {trigger && <ChevronDown className="h-3.5 w-3.5" />}
      </Button>
      {open && (
        <div
          className={`absolute right-0 top-full mt-1 z-50 ${width} rounded-md border bg-popover p-1 shadow-md`}
          onClick={() => setOpen(false)}
          role="menu"
          aria-label={title}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function OverflowItem({
  icon: Icon,
  onClick,
  children,
  danger,
  warning,
  disabled,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
  warning?: boolean;
  disabled?: boolean;
}) {
  const colorClass = danger
    ? 'text-destructive hover:bg-destructive/10'
    : warning
    ? 'text-amber-500 hover:bg-amber-500/10'
    : 'hover:bg-accent';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      role="menuitem"
      className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm disabled:pointer-events-none disabled:opacity-50 ${colorClass}`}
    >
      {Icon && <Icon className="h-3.5 w-3.5" />} {children}
    </button>
  );
}

export function OverflowSep() {
  return <div className="my-1 h-px bg-border" />;
}

export function OverflowLink({
  to,
  params,
  icon: Icon,
  children,
}: {
  to: string;
  params?: Record<string, string>;
  icon?: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to as never}
      params={params as never}
      role="menuitem"
      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
    >
      {Icon && <Icon className="h-3.5 w-3.5" />} {children}
    </Link>
  );
}

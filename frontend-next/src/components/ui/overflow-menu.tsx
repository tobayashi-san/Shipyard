import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const focusFrame = requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled]):not([aria-disabled="true"])')
        ?.focus();
    });
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        requestAnimationFrame(() => triggerRef.current?.focus());
      }
    };
    document.addEventListener('click', handler);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('click', handler);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;

    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([disabled]):not([aria-disabled="true"])',
      ) ?? [],
    );
    if (items.length === 0) return;

    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowUp'
          ? currentIndex <= 0 ? items.length - 1 : currentIndex - 1
          : currentIndex < 0 || currentIndex === items.length - 1 ? 0 : currentIndex + 1;
    items[nextIndex]?.focus();
  };

  return (
    <div className="relative" ref={ref}>
      <Button ref={triggerRef} variant={trigger ? "outline" : "ghost"} size={trigger ? "sm" : "icon"} onClick={() => setOpen((current) => !current)} title={title} aria-label={title} aria-haspopup="menu" aria-expanded={open}>
        {trigger || <MoreVertical className="h-4 w-4" />}
        {trigger && <ChevronDown className="h-3.5 w-3.5" />}
      </Button>
      {open && (
        <div
          ref={menuRef}
          className={`absolute right-0 top-full mt-1 z-50 ${width} rounded-md border bg-popover p-1 shadow-md`}
          onClick={() => setOpen(false)}
          onKeyDown={handleMenuKeyDown}
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
      className={`flex min-h-9 w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 ${colorClass}`}
    >
      {Icon && <Icon className="h-3.5 w-3.5" />} {children}
    </button>
  );
}

export function OverflowSep() {
  return <div className="my-1 h-px bg-border" role="separator" />;
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
      className="flex min-h-9 w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {Icon && <Icon className="h-3.5 w-3.5" />} {children}
    </Link>
  );
}

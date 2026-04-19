import { useEffect, useRef, useState } from 'react';
import { MoreVertical } from 'lucide-react';
import { Button } from './button';

// ─── OverflowMenu ─────────────────────────────────────────────
// Click-outside-aware popover triggered by a vertical "⋮" icon button.
// Use with <OverflowItem /> and <OverflowSep />.
export function OverflowMenu({
  children,
  width = 'w-56',
  title = 'Actions',
}: {
  children: React.ReactNode;
  width?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <Button variant="ghost" size="icon" onClick={() => setOpen(!open)} title={title}>
        <MoreVertical className="h-4 w-4" />
      </Button>
      {open && (
        <div
          className={`absolute right-0 top-full mt-1 z-50 ${width} rounded-md border bg-popover p-1 shadow-md`}
          onClick={() => setOpen(false)}
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
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm disabled:opacity-50 disabled:pointer-events-none ${colorClass}`}
    >
      {Icon && <Icon className="h-3.5 w-3.5" />} {children}
    </button>
  );
}

export function OverflowSep() {
  return <div className="my-1 h-px bg-border" />;
}

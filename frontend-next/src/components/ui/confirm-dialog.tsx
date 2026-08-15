import { useEffect, useId, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './dialog';
import { Button } from './button';
import { Input } from './input';
import { Label } from './label';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'destructive' | 'warning';
  onConfirm: () => void;
  isPending?: boolean;
  confirmTextValue?: string;
  confirmInputLabel?: string;
  confirmInputPlaceholder?: string;
  confirmInputHelp?: React.ReactNode;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'destructive',
  onConfirm,
  isPending,
  confirmTextValue,
  confirmInputLabel = 'Type to confirm',
  confirmInputPlaceholder,
  confirmInputHelp,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const confirmInputId = useId();
  const requiredValue = String(confirmTextValue ?? '');
  const requiresText = requiredValue.length > 0;
  const canConfirm = !requiresText || typed === requiredValue;

  useEffect(() => {
    if (!open) setTyped('');
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div className="text-sm text-muted-foreground mt-1">{description}</div>
          </DialogDescription>
        </DialogHeader>
        {requiresText && (
          <div className="space-y-2">
            <Label htmlFor={confirmInputId}>{confirmInputLabel}</Label>
            <Input
              id={confirmInputId}
              value={typed}
              // `input` is deliberately handled in addition to React's
              // change abstraction.  Browser autofill/password managers and
              // some WebKit/Firefox paths update the native value first; the
              // destructive-action guard must follow that value immediately.
              onInput={(e) => setTyped(e.currentTarget.value)}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={confirmInputPlaceholder ?? requiredValue}
              autoComplete="off"
              className="font-mono"
            />
            <div className="text-xs text-muted-foreground">
              {confirmInputHelp ?? (
                <>
                  Type <span className="font-mono text-foreground">{requiredValue}</span> to enable this action.
                </>
              )}
            </div>
          </div>
        )}
        <DialogFooter className="mt-2 gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            {cancelLabel}
          </Button>
          <Button
            variant={variant === 'destructive' ? 'destructive' : 'outline'}
            className={variant === 'warning' ? 'border-amber-500 bg-amber-500 text-white hover:bg-amber-600' : undefined}
            onClick={() => { onConfirm(); onOpenChange(false); }}
            disabled={isPending || !canConfirm}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

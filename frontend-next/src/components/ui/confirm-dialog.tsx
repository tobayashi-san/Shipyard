import { useEffect, useState } from 'react';
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
            <Label>{confirmInputLabel}</Label>
            <Input
              value={typed}
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

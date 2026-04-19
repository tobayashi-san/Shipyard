import { useEffect, useRef } from 'react';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useTranslation } from 'react-i18next';

export interface OutputLine {
  text: string;
  cls?: string;
}

export type RunStatus = 'running' | 'success' | 'failed';

interface ActionRunDialogProps {
  open: boolean;
  title: string;
  status: RunStatus;
  lines: OutputLine[];
  onClose: () => void;
  /** If false (default), Close button is hidden while running */
  allowCloseWhileRunning?: boolean;
}

export function ActionRunDialog({ open, title, status, lines, onClose, allowCloseWhileRunning }: ActionRunDialogProps) {
  const { t } = useTranslation();
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new lines
  useEffect(() => {
    if (open) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [lines, open]);

  const canClose = status !== 'running' || allowCloseWhileRunning;

  function handleOpenChange(isOpen: boolean) {
    if (!isOpen && canClose) onClose();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {status === 'running' && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
            {status === 'success' && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
            {status === 'failed' && <XCircle className="h-4 w-4 text-destructive" />}
            {title}
          </DialogTitle>
        </DialogHeader>

        <div className="rounded-md border bg-muted/30">
          <div className="max-h-96 overflow-y-auto p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {lines.map((line, i) => (
              <div key={i} className={line.cls}>{line.text}</div>
            ))}
            {status === 'running' && (
              <div className="mt-1 text-muted-foreground animate-pulse">▌</div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        {status !== 'running' && (
          <div className={`text-xs font-medium ${status === 'success' ? 'text-emerald-500' : 'text-destructive'}`}>
            {status === 'success' ? t('det.actionSuccess') : t('det.actionFailed')}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={!canClose}
          >
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

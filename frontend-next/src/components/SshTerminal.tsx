import { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { getToken } from '@/lib/auth';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';

interface SshTerminalProps {
  server: Record<string, unknown>;
  onClose: () => void;
}

/**
 * Full-screen overlay that opens an xterm.js SSH session via WebSocket.
 * xterm + fit addon are lazily imported so they stay in the `terminal` chunk.
 */
export function SshTerminal({ server, onClose }: SshTerminalProps) {
  const { t } = useTranslation();
  const theme = useUi((state) => state.theme);
  const isDark = theme === 'dark' || (theme === 'system' && typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const containerRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const dotRef = useRef<HTMLSpanElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<import('@xterm/xterm').Terminal | null>(null);

  const setStatus = useCallback((state: 'connecting' | 'online' | 'offline', text: string) => {
    if (dotRef.current) {
      dotRef.current.className = cn(
        'inline-block h-2 w-2 rounded-full',
        state === 'online' ? 'bg-green-500' : state === 'connecting' ? 'bg-yellow-500 animate-pulse' : 'bg-red-500'
      );
    }
    if (statusRef.current) statusRef.current.textContent = text;
  }, []);

  useEffect(() => {
    let disposed = false;
    let resizeObs: ResizeObserver | null = null;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      // xterm CSS is loaded via the side-effect import below
      await import('@xterm/xterm/css/xterm.css' as string);

      if (disposed || !containerRef.current) return;

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: '"JetBrains Mono","Fira Code","Cascadia Code",monospace',
        scrollback: 5000,
        theme: isDark ? {
          background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff', selectionBackground: 'rgba(88,166,255,0.25)',
          black: '#484f58', brightBlack: '#6e7681', red: '#ff7b72', brightRed: '#ffa198', green: '#3fb950', brightGreen: '#56d364',
          yellow: '#d29922', brightYellow: '#e3b341', blue: '#58a6ff', brightBlue: '#79c0ff', magenta: '#bc8cff', brightMagenta: '#d2a8ff',
          cyan: '#39c5cf', brightCyan: '#56d4dd', white: '#b1bac4', brightWhite: '#f0f6fc',
        } : {
          background: '#ffffff', foreground: '#172b4d', cursor: '#0f6cbd', selectionBackground: 'rgba(15,108,189,0.18)',
          black: '#172b4d', brightBlack: '#5e6c84', red: '#c9372c', brightRed: '#e34935', green: '#216e4e', brightGreen: '#2a8b65',
          yellow: '#8f6b00', brightYellow: '#a87b00', blue: '#0c66e4', brightBlue: '#0055cc', magenta: '#803fa5', brightMagenta: '#9747ff',
          cyan: '#006b75', brightCyan: '#007f89', white: '#dfe1e6', brightWhite: '#ffffff',
        },
      });
      termRef.current = term;

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerRef.current);

      // Double rAF for correct measurement
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (disposed) return;
        fitAddon.fit();
        term.focus();

        // Connect WebSocket
        const { cols, rows } = term;
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const token = getToken();
        const wsUrl = `${protocol}//${location.host}/ws/ssh`
          + `?serverId=${encodeURIComponent(String(server.id))}`
          + `&cols=${cols}&rows=${rows}`
          + (token ? `&token=${encodeURIComponent(token)}` : '');

        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        let ready = false;

        ws.onopen = () => {
          setStatus('connecting', t('term.connecting'));
        };

        ws.onmessage = (e) => {
          if (typeof e.data === 'string' && e.data.charCodeAt(0) === 123) {
            try {
              const msg = JSON.parse(e.data);
              if (msg.type === 'ready') {
                ready = true;
                const userLabel = (server.ssh_user as string) || 'root';
                setStatus('online', t('term.connectedAs', { user: userLabel }));
              } else if (msg.type === 'error') {
                setStatus('offline', t('term.error'));
                term.write(`\r\n\x1b[31m${t('term.error')}: ${msg.message}\x1b[0m\r\n`);
              } else if (msg.type === 'closed') {
                setStatus('offline', t('term.disconnected'));
                term.write(`\r\n\x1b[33m${t('term.connClosed')}\x1b[0m\r\n`);
              }
              return;
            } catch { /* fall through to raw output */ }
          }
          term.write(e.data);
        };

        ws.onclose = () => {
          if (!ready) setStatus('offline', t('term.connFailed'));
        };

        ws.onerror = () => {
          setStatus('offline', t('term.wsError'));
          term.write(`\r\n\x1b[31m${t('term.wsError')}\x1b[0m\r\n`);
        };

        term.onData((data) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input', data }));
          }
        });

        // Resize observer
        resizeObs = new ResizeObserver(() => {
          fitAddon.fit();
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          }
        });
        resizeObs.observe(containerRef.current!);
      }));
    })();

    // Escape key handler
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);

    return () => {
      disposed = true;
      document.removeEventListener('keydown', onKey);
      resizeObs?.disconnect();
      wsRef.current?.close();
      termRef.current?.dispose();
      // Restore focus to whichever element opened the terminal
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        try { previouslyFocused.focus(); } catch { /* ignore */ }
      }
    };
  }, [isDark]); // eslint-disable-line react-hooks/exhaustive-deps

  const userLabel = (server.ssh_user as string) || 'root';
  const serverName = (server.name as string) || '';
  const hostname = (server.hostname as string) || serverName;
  const ip = (server.ip_address as string) || '';

  return createPortal(
    <div
      className="fixed inset-0 z-[2000] flex items-start justify-center bg-black/55 p-4 pt-16"
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('term.dialogLabel', { name: serverName || hostname || 'server' })}
        className={cn(
          'flex h-[calc(100dvh-8rem)] max-h-[48rem] w-full max-w-[1100px] flex-col overflow-hidden rounded-[3px] border shadow-xl',
          isDark ? 'border-[#30363d] bg-[#0d1117]' : 'border-border-strong bg-card'
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className={cn('flex items-center justify-between border-b px-4 py-2.5', isDark ? 'border-[#30363d]' : 'border-border bg-secondary/45')}>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <span className={cn('text-xs font-medium uppercase tracking-wider', isDark ? 'text-[#8b949e]' : 'text-muted-foreground')}>
                {t('common.terminal')}
              </span>
              <span className={cn('truncate font-semibold', isDark ? 'text-[#c9d1d9]' : 'text-foreground')}>{serverName}</span>
            </div>
            <div className={cn('truncate text-xs', isDark ? 'text-[#8b949e]' : 'text-muted-foreground')}>
              {userLabel}@{hostname} &middot; {ip}
            </div>
          </div>
          <div className="flex items-center gap-3" aria-live="polite">
            <span ref={dotRef} aria-hidden="true" className="inline-block h-2 w-2 animate-pulse rounded-full bg-yellow-500" />
            <span ref={statusRef} className={cn('text-xs', isDark ? 'text-[#8b949e]' : 'text-muted-foreground')}>{t('term.connecting')}</span>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common.close')}
              className={cn('rounded p-1 focus-visible:outline-none', isDark ? 'text-[#8b949e] hover:bg-[#21262d] hover:text-[#c9d1d9]' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}
              title={`${t('common.close')} (Esc)`}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Terminal container */}
        <div className={cn('flex-1 min-w-0 overflow-hidden p-3 sm:p-4', isDark ? 'bg-[#0d1117]' : 'bg-white')}>
          <div ref={containerRef} className="h-full w-full" />
        </div>
      </div>
    </div>,
    document.body
  );
}

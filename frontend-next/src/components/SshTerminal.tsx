import { useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { getToken } from '@/lib/auth';
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
        theme: {
          background:          '#0d1117',
          foreground:          '#c9d1d9',
          cursor:              '#58a6ff',
          selectionBackground: 'rgba(88,166,255,0.25)',
          black:   '#484f58', brightBlack:   '#6e7681',
          red:     '#ff7b72', brightRed:     '#ffa198',
          green:   '#3fb950', brightGreen:   '#56d364',
          yellow:  '#d29922', brightYellow:  '#e3b341',
          blue:    '#58a6ff', brightBlue:    '#79c0ff',
          magenta: '#bc8cff', brightMagenta: '#d2a8ff',
          cyan:    '#39c5cf', brightCyan:    '#56d4dd',
          white:   '#b1bac4', brightWhite:   '#f0f6fc',
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
                setStatus('online', `Connected as ${userLabel}`);
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
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const userLabel = (server.ssh_user as string) || 'root';
  const serverName = (server.name as string) || '';
  const hostname = (server.hostname as string) || serverName;
  const ip = (server.ip_address as string) || '';

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/70"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="flex h-[75vh] w-[90vw] max-w-[1100px] flex-col overflow-hidden rounded-xl border border-[#30363d] bg-[#0d1117] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#30363d] px-4 py-2.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-xs font-medium uppercase tracking-wider text-[#8b949e]">
                {t('common.terminal')}
              </span>
              <span className="font-semibold text-[#c9d1d9]">{serverName}</span>
            </div>
            <div className="text-xs text-[#8b949e]">
              {userLabel}@{hostname} &middot; {ip}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span ref={dotRef} className="inline-block h-2 w-2 animate-pulse rounded-full bg-yellow-500" />
            <span ref={statusRef} className="text-xs text-[#8b949e]">{t('term.connecting')}</span>
            <button
              onClick={onClose}
              className="rounded p-1 text-[#8b949e] hover:bg-[#21262d] hover:text-[#c9d1d9]"
              title={`${t('common.close')} (Esc)`}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Terminal container */}
        <div className="flex-1 p-1">
          <div ref={containerRef} className="h-full w-full" />
        </div>
      </div>
    </div>
  );
}

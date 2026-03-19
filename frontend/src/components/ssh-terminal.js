import { Terminal } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import { api } from '../api.js';
import { t } from '../i18n.js';
import 'xterm/css/xterm.css';

export function openSshTerminal(server) {
  // Build overlay independently – no .modal-overlay conflict
  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2000',
    'background:rgba(0,0,0,.7)',
    'display:flex', 'align-items:center', 'justify-content:center',
  ].join(';');

  const modal = document.createElement('div');
  modal.style.cssText = [
    'width:90vw', 'max-width:1100px', 'height:75vh',
    'background:#0d1117',
    'border-radius:8px',
    'border:1px solid #30363d',
    'display:flex', 'flex-direction:column',
    'overflow:hidden',
    'box-shadow:0 8px 32px rgba(0,0,0,.6)',
  ].join(';');

  modal.innerHTML = `
    <div class="ssh-terminal-header">
      <span><i class="fas fa-terminal"></i>&nbsp; ${server.name} &middot; ${server.ip_address}</span>
      <div style="display:flex;gap:10px;align-items:center;">
        <span id="ssh-status-dot" class="ssh-status-dot connecting"></span>
        <span id="ssh-status-text" style="font-size:12px;color:#8b949e;">${t('term.connecting')}</span>
        <button id="ssh-term-close" style="background:none;border:none;color:#8b949e;font-size:22px;line-height:1;cursor:pointer;padding:0 2px;">×</button>
      </div>
    </div>
    <div id="ssh-term-container" style="flex:1;overflow:hidden;padding:4px;box-sizing:border-box;"></div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // ── xterm ──────────────────────────────────────────────────
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

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  const container = modal.querySelector('#ssh-term-container');
  term.open(container);

  // Double rAF ensures the browser has painted and FitAddon can measure correctly
  requestAnimationFrame(() => requestAnimationFrame(() => {
    fitAddon.fit();
    connectSsh();
  }));

  // ── Helpers ────────────────────────────────────────────────
  function setStatus(st, text) {
    modal.querySelector('#ssh-status-dot').className = `ssh-status-dot ${st}`;
    modal.querySelector('#ssh-status-text').textContent = text;
  }

  // ── WebSocket → SSH ────────────────────────────────────────
  function connectSsh() {
    const { cols, rows } = term;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token    = api.getToken();
    const wsUrl    = `${protocol}//${location.host}/ws/ssh`
      + `?serverId=${encodeURIComponent(server.id)}`
      + `&cols=${cols}&rows=${rows}`
      + (token ? `&token=${encodeURIComponent(token)}` : '');

    const ws  = new WebSocket(wsUrl);
    let ready = false;

    ws.onopen = () => {
      term.write(`\r\n\x1b[33m  ⟳  ${t('term.connectingTo', { name: server.name, ip: server.ip_address })}\x1b[0m\r\n`);
    };

    ws.onmessage = e => {
      // Control messages are JSON; raw terminal output is plain text/binary
      if (typeof e.data === 'string' && e.data.charCodeAt(0) === 123 /* '{' */) {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'ready') {
            ready = true;
            setStatus('online', t('term.connected'));
            // Build banner — measure ONLY visible chars, add ANSI after padding
            const D    = Math.min(term.cols - 2, 50);
            const fill = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
            const row  = (txt) => `│ ${fill(txt, D - 2)} │`;
            const hr   = '─'.repeat(D);
            const l1   = `✓  ${server.name}`;
            const l2   = `   ${server.ip_address}  ·  ${server.ssh_user || 'root'}`;
            term.write(
              `\r\x1b[K` +                               // overwrite connecting line
              `\x1b[32m┌${hr}┐\r\n` +
              `\x1b[1m${row(l1)}\x1b[0;32m\r\n` +
              `\x1b[2m${row(l2)}\x1b[0m\r\n` +
              `\x1b[32m└${hr}┘\x1b[0m\r\n\r\n`
            );
          } else if (msg.type === 'error') {
            setStatus('offline', t('term.error'));
            term.write(`\r\n\x1b[31m${t('term.error')}: ${msg.message}\x1b[0m\r\n`);
          } else if (msg.type === 'closed') {
            setStatus('offline', t('term.disconnected'));
            term.write(`\r\n\x1b[33m${t('term.connClosed')}\x1b[0m\r\n`);
          }
          return;
        } catch { /* fall through */ }
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

    term.onData(data => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // Terminal resize
    const resizeObs = new ResizeObserver(() => {
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    });
    resizeObs.observe(container);

    // Close
    const closeAll = () => {
      resizeObs.disconnect();
      ws.close();
      term.dispose();
      overlay.remove();
    };

    modal.querySelector('#ssh-term-close').addEventListener('click', closeAll);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeAll(); });
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape') { closeAll(); document.removeEventListener('keydown', onEsc); }
    });
  }
}

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { api } from '../api.js';
import { t } from '../i18n.js';
import { esc } from '../utils/format.js';
import '@xterm/xterm/css/xterm.css';

export function openSshTerminal(server) {
  // Build overlay independently – no .modal-overlay conflict
  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2000',
    'background:rgba(0,0,0,.7)',
    'display:flex', 'align-items:center', 'justify-content:center',
  ].join(';');

  const modal = document.createElement('div');
  const userLabel = server.ssh_user || 'root';
  modal.style.cssText = [
    'width:90vw', 'max-width:1100px', 'height:75vh',
    'background:var(--terminal-bg)',
    'border-radius:12px',
    'border:1px solid var(--terminal-border)',
    'display:flex', 'flex-direction:column',
    'overflow:hidden',
    'box-shadow:0 8px 32px rgba(0,0,0,.6)',
  ].join(';');

  modal.innerHTML = `
    <div class="ssh-terminal-header">
      <div class="ssh-terminal-title-wrap">
        <div class="ssh-terminal-title-row">
          <span class="ssh-terminal-kicker">${t('common.terminal')}</span>
          <span class="ssh-terminal-title">${esc(server.name)}</span>
        </div>
        <div class="ssh-terminal-subtitle">${esc(userLabel)}@${esc(server.hostname || server.name)} <span class="ssh-terminal-sub-sep">&middot;</span> ${esc(server.ip_address)}</div>
      </div>
      <div class="ssh-terminal-header-actions">
        <span id="ssh-status-dot" class="ssh-status-dot connecting"></span>
        <span id="ssh-status-text" class="ssh-status-text">${t('term.connecting')}</span>
        <button id="ssh-term-close" class="ssh-term-close" title="${t('common.close')} (Esc)" aria-label="${t('common.close')}">
          <i class="fas fa-times"></i>
        </button>
      </div>
    </div>
    <div class="ssh-term-shell">
      <div id="ssh-term-container" class="ssh-term-container"></div>
    </div>
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
    term.focus();
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
      setStatus('connecting', t('term.connecting'));
    };

    ws.onmessage = e => {
      // Control messages are JSON; raw terminal output is plain text/binary
      if (typeof e.data === 'string' && e.data.charCodeAt(0) === 123 /* '{' */) {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'ready') {
            ready = true;
            setStatus('online', `Connected as ${userLabel}`);
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
    let cleanedUp = false;
    const onEsc = (e) => {
      if (e.key === 'Escape') closeAll();
    };

    const closeAll = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      resizeObs.disconnect();
      ws.close();
      term.dispose();
      document.removeEventListener('keydown', onEsc);
      overlay.remove();
    };

    modal.querySelector('#ssh-term-close').addEventListener('click', closeAll);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeAll(); });
    document.addEventListener('keydown', onEsc);
  }
}

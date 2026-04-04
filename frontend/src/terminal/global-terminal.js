function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\x1b[78]/g, '')
    .replace(/\r/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

export function openGlobalTerminal(title) {
  const el = document.getElementById('global-terminal');
  const body = document.getElementById('global-terminal-body');
  const titleEl = document.getElementById('global-terminal-title');
  if (!el) return;
  if (titleEl) titleEl.textContent = title || '';
  if (body) body.innerHTML = '';
  el.style.display = '';
  if (body) body.style.height = body._savedHeight || '240px';
  const toggleBtn = document.getElementById('global-terminal-toggle');
  if (toggleBtn) toggleBtn.textContent = '▼';
}

export function appendGlobalTerminal(text, type = 'stdout') {
  const body = document.getElementById('global-terminal-body');
  if (!body) return;
  const clean = stripAnsi(text);
  if (!clean.trim()) return;
  const line = document.createElement('div');
  line.style.cssText = type === 'stderr'
    ? 'color:var(--terminal-stderr);padding:1px 0;'
    : type === 'success'
    ? 'color:var(--terminal-success);padding:1px 0;'
    : 'color:var(--terminal-text);padding:1px 0;';
  line.textContent = clean;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
}

export function setupGlobalTerminal() {
  if (setupGlobalTerminal._initialized) return;
  setupGlobalTerminal._initialized = true;

  document.getElementById('global-terminal-close')?.addEventListener('click', () => {
    const el = document.getElementById('global-terminal');
    if (el) el.style.display = 'none';
  });

  document.getElementById('global-terminal-toggle')?.addEventListener('click', () => {
    const body = document.getElementById('global-terminal-body');
    const btn = document.getElementById('global-terminal-toggle');
    if (!body) return;
    if (body.style.height === '0px') {
      body.style.height = (body._savedHeight || '240px');
      body.style.padding = '12px 16px';
      if (btn) btn.textContent = '▼';
    } else {
      body._savedHeight = body.style.height || '240px';
      body.style.height = '0px';
      body.style.padding = '0';
      if (btn) btn.textContent = '▲';
    }
  });

  const handle = document.getElementById('global-terminal-resize');
  const body = document.getElementById('global-terminal-body');
  if (!handle || !body) return;
  let dragging = false;
  let startY = 0;
  let startH = 0;
  handle.addEventListener('mousedown', e => {
    dragging = true;
    startY = e.clientY;
    startH = parseInt(body.style.height) || 240;
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const delta = startY - e.clientY;
    const newH = Math.max(80, Math.min(window.innerHeight * 0.85, startH + delta));
    body.style.height = newH + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
  });
}

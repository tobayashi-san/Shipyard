import { api }       from './api.js';
import { state }     from './main.js';
import { onWsMessage } from './websocket.js';
import { showToast, showConfirm } from './components/toast.js';

let _activePlugin = null; // { id, mod }

/**
 * Creates a namespaced API helper for a plugin.
 * All requests are routed to /api/plugin/:pluginId/...
 */
function createPluginApi(pluginId) {
  return {
    request(path, options) {
      return api.request(`/plugin/${pluginId}${path}`, options);
    },
  };
}

/**
 * Unmounts the currently active plugin (if any).
 */
export async function cleanupPlugin() {
  if (!_activePlugin) return;
  try {
    if (typeof _activePlugin.mod.unmount === 'function') {
      await _activePlugin.mod.unmount();
    }
  } catch (e) {
    console.warn(`[plugins] unmount error for ${_activePlugin.id}:`, e);
  }
  _activePlugin = null;
}

/**
 * Mounts a plugin's UI into the given container element.
 */
export async function renderPlugin(pluginId) {
  const container = document.querySelector('.main-content');
  if (!container) return;

  // Unmount previous plugin
  await cleanupPlugin();

  container.innerHTML = `<div class="loading-state" style="padding:48px;"><div class="loader"></div></div>`;

  try {
    // Cache-bust with Date.now() so reload works immediately after plugin update
    const mod = await import(`/plugins/${pluginId}/ui.js?v=${Date.now()}`);
    _activePlugin = { id: pluginId, mod };

    container.innerHTML = '';

    if (typeof mod.mount === 'function') {
      await mod.mount(container, {
        api,
        pluginApi: createPluginApi(pluginId),
        state,
        navigate:    (view, params) => import('./main.js').then(m => m.navigate(view, params)),
        showToast,
        showConfirm,
        onWsMessage,
      });
    } else {
      container.innerHTML = `<div class="empty-state"><p>Plugin <strong>${pluginId}</strong> has no UI (missing <code>mount()</code> export).</p></div>`;
    }
  } catch (e) {
    console.error(`[plugins] Failed to load plugin "${pluginId}":`, e);
    container.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-puzzle-piece" style="font-size:2rem;margin-bottom:12px;opacity:.4;"></i>
        <p>Failed to load plugin <strong>${pluginId}</strong>.</p>
        <p style="font-size:12px;color:var(--text-muted);margin-top:4px;">${e.message}</p>
      </div>`;
  }
}

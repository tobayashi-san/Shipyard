/**
 * Shipyard Plugin — Frontend Entry Point
 *
 * Two exports are required:
 *   mount(container, helpers)  — called when the user navigates to this plugin
 *   unmount()                  — called when the user navigates away
 *
 * The helpers object provides:
 *   api         — the global Shipyard ApiClient (for /api/... routes)
 *   pluginApi   — namespaced API helper for this plugin's backend (/api/plugin/<id>/...)
 *   state       — the global app state (servers, plugins, whiteLabel, …)
 *   navigate    — function(view, params) to navigate to another view
 *   showToast   — function(message, type) to show a notification
 *   showConfirm — function(message, opts) → Promise<boolean> for a confirmation dialog
 *   onWsMessage — function(callback) → unsubscribe function for WebSocket messages
 */

let _container = null;
let _wsUnsub   = null;

export async function mount(container, { api, pluginApi, state, navigate, showToast, onWsMessage }) {
  _container = container;

  // Render initial HTML
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h2>My Plugin</h2>
        <p>Plugin content goes here.</p>
      </div>
    </div>
    <div class="page-content" id="my-plugin-content">
      <div class="loading-state"><div class="loader"></div> Loading…</div>
    </div>
  `;

  // Fetch data from this plugin's backend
  try {
    const data = await pluginApi.request('/hello');
    document.getElementById('my-plugin-content').innerHTML = `
      <div class="card">
        <div class="card-body">
          <p>${data.message}</p>
          <p>There are <strong>${state.servers.length}</strong> servers registered.</p>
          <button class="btn btn-primary btn-sm" id="my-plugin-btn">Click me</button>
        </div>
      </div>
    `;
    document.getElementById('my-plugin-btn')?.addEventListener('click', () => {
      showToast('Hello from the plugin!', 'success');
    });
  } catch (e) {
    document.getElementById('my-plugin-content').innerHTML = `
      <div class="empty-state"><p>Error: ${e.message}</p></div>
    `;
  }

  // Listen for WebSocket messages from the server
  _wsUnsub = onWsMessage(msg => {
    if (msg.type === 'plugin_event' && msg.pluginId === 'my-plugin') {
      console.log('[my-plugin] WS event:', msg.data);
    }
  });
}

export function unmount() {
  // Stop listening for WS messages
  if (_wsUnsub) { _wsUnsub(); _wsUnsub = null; }
  // Clean up any timers, listeners, etc.
  _container = null;
}

# Shipyard Plugin Template

Use this template as a starting point for building Shipyard plugins.

## Directory Structure

```
my-plugin/
├── manifest.json   ← Required: plugin metadata
├── index.js        ← Optional: backend (Node.js/Express)
└── ui.js           ← Optional: frontend (ES Module)
```

## Getting Started

1. Copy this directory and rename it to your plugin's id (e.g. `my-plugin`).
2. Edit `manifest.json` — set `id` to match the directory name.
3. Implement `index.js` (backend routes) and/or `ui.js` (frontend UI).
4. Place the directory in `/app/plugins/my-plugin/`.
5. Go to **Settings → Plugins** and click **Reload**, then enable your plugin.

## manifest.json

```json
{
  "id": "my-plugin",          ← Must match the directory name (lowercase, a-z, 0-9, - or _)
  "name": "My Plugin",        ← Display name shown in the UI
  "version": "1.0.0",         ← Semver version string
  "description": "…",        ← Short description
  "author": "Your Name",
  "sidebar": {                ← Optional: show a link in the sidebar
    "icon": "fas fa-star",    ← Any Font Awesome 6 icon class
    "label": "My Plugin"      ← Sidebar link text
  }
}
```

## index.js — Backend

```js
function register({ router, db, broadcast, sshManager, ansibleRunner, scheduler, pluginId, pluginDir }) {
  // Routes are mounted at /api/plugin/<id>/
  // Auth middleware is already applied — only authenticated users can call these.
  router.get('/status', (req, res) => {
    res.json({ ok: true });
  });
}

module.exports = { register };
```

### Available helpers

| Helper         | Description |
|----------------|-------------|
| `router`       | Express Router mounted at `/api/plugin/<id>/`, auth-protected |
| `db`           | Shipyard DB instance (servers, settings, auditLog, …) |
| `broadcast`    | `(data)` → sends a WebSocket message to all connected clients |
| `sshManager`   | SSH helper — `execStream(server, cmd, onChunk)`, `getPrivateKey()` |
| `ansibleRunner`| Ansible helper — `runPlaybook(name, targets, vars, onOutput)` |
| `scheduler`    | Background polling scheduler |
| `pluginId`     | This plugin's id string |
| `pluginDir`    | Absolute path to this plugin directory |

## ui.js — Frontend

```js
let _wsUnsub = null;

export async function mount(container, { api, pluginApi, state, navigate, showToast, showConfirm, onWsMessage }) {
  container.innerHTML = '<h2>Hello!</h2>';

  // Call your plugin's own backend
  const data = await pluginApi.request('/status');

  // Call any Shipyard API
  const servers = await api.getServers();

  // Subscribe to WebSocket events
  _wsUnsub = onWsMessage(msg => {
    if (msg.type === 'plugin_event') console.log(msg);
  });
}

export function unmount() {
  if (_wsUnsub) { _wsUnsub(); _wsUnsub = null; }
}
```

### Available helpers

| Helper        | Description |
|---------------|-------------|
| `api`         | Global Shipyard API client |
| `pluginApi`   | Namespaced API client for `/api/plugin/<id>/...` |
| `state`       | Global app state (`servers`, `plugins`, `whiteLabel`, …) |
| `navigate`    | `(view, params)` — navigate to another view |
| `showToast`   | `(message, type)` — show a toast notification |
| `showConfirm` | `(message, opts)` → `Promise<boolean>` — show a confirm dialog |
| `onWsMessage` | `(callback)` → unsubscribe function — listen for WebSocket messages |

## Security

Plugins run as **Node.js code on the server** with full access to the file system,
SSH connections, the Shipyard database, and the network. Only install plugins from
trusted sources. Shipyard shows a security warning when you enable a new plugin.

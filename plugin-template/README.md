# Shipyard Plugin Template

Starting point for building Shipyard plugins. Copy this directory, rename it to your plugin's ID, implement `index.js` and/or `ui.js`, and drop it into `/app/plugins/`.

Plugins can add backend routes, mount a frontend UI inside the Shipyard app, or both. Backend plugin code runs inside the Shipyard server process, so treat every plugin as trusted code.

## Directory Structure

```
my-plugin/
├── manifest.json   ← required: plugin metadata
├── index.js        ← optional: backend (Node.js / Express routes)
└── ui.js           ← optional: frontend (ES Module)
```

## Getting Started

1. Copy this directory and rename it to your plugin's ID (e.g. `my-plugin`).
2. Edit `manifest.json` — set `id` to match the directory name exactly.
3. Implement `index.js` and/or `ui.js` (see sections below).
4. Place the directory in `/app/plugins/my-plugin/`.
5. Go to **Settings → Plugins**, click **Reload**, then enable your plugin.

**Docker:** mount your plugin directory into the container via `docker-compose.yml`:

```yaml
# docker-compose.yml
services:
  shipyard:
    volumes:
      - ./my-plugin:/app/plugins/my-plugin
```

## manifest.json

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "Short description shown in Settings → Plugins.",
  "author": "Your Name",
  "sidebar": {
    "icon": "fas fa-cube",
    "label": "My Plugin"
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Must match the directory name. Lowercase, `a-z 0-9 - _` only. |
| `name` | yes | Display name shown in the UI. |
| `version` | yes | Semver string. |
| `description` | yes | Shown in Settings → Plugins. |
| `author` | no | |
| `sidebar` | no | Adds a link to the sidebar. `icon` accepts common Font Awesome-style names; unknown values fall back to a puzzle icon. |

Currently recognized sidebar icon hints include `fa-cube`, `fa-terminal`, `fa-server`, `fa-shield`, `fa-cubes`, `fa-network`, `fa-anchor`, and `fa-ship`.

## index.js — Backend

```js
function register({ router, db, broadcast, sshManager, ansibleRunner, scheduler, pluginId, pluginDir }) {
  // Routes are mounted at /api/plugin/<id>/
  // JWT auth middleware is already applied — only authenticated requests reach here.

  router.get('/status', (req, res) => {
    res.json({ ok: true, pluginId });
  });

  router.post('/run', async (req, res) => {
    const servers = db.servers.getAll();
    res.json({ started: true });

    // Stream output to all connected browser clients
    broadcast({ type: 'my_plugin_output', data: `Running on ${servers.length} server(s)` });
  });
}

module.exports = { register };
```

### Injected helpers

| Helper | Type | Description |
|---|---|---|
| `router` | Express Router | Mounted at `/api/plugin/<id>/`, JWT-protected. |
| `db` | Object | Shipyard DB — `db.servers.getAll()`, `db.settings.get(key)`, `db.auditLog.write(...)`, etc. |
| `broadcast` | `(data) => void` | Send a WebSocket message to all connected browser clients. |
| `sshManager` | Object | SSH helpers — see table below. |
| `ansibleRunner` | Object | `runPlaybook(name, targets, vars, onOutput)`, `runAdHoc(targets, module, args, onOutput)` |
| `scheduler` | Object | Background polling scheduler. |
| `pluginId` | string | This plugin's ID as declared in `manifest.json`. |
| `pluginDir` | string | Absolute path to this plugin's directory inside the container. |

#### sshManager helpers

| Method | Description |
|---|---|
| `execCommand(server, cmd)` | Run a command via SSH, returns `{ stdout, stderr, code }`. |
| `execStream(server, cmd, onChunk)` | Run a command and stream stdout chunks; returns exit code. |
| `getPrivateKey()` | Returns the decrypted private key string (for use with ssh2 directly). |
| `testConnection(server)` | Returns `true` if the server is reachable via SSH. |

## ui.js — Frontend

```js
let _wsUnsub = null;

export async function mount(container, { api, pluginApi, state, navigate, showToast, showConfirm, onWsMessage }) {
  container.textContent = 'Loading...';

  // Call your plugin's own backend routes
  const status = await pluginApi.request('/status');

  // Call any Shipyard core API
  const servers = await api.getServers();

  container.innerHTML = `
    <div>
      <h2>Hello from my-plugin!</h2>
      <p>${servers.length} server(s)</p>
    </div>
  `;

  // Subscribe to WebSocket messages (auto-unsubscribed on unmount)
  _wsUnsub = onWsMessage(msg => {
    if (msg.type === 'my_plugin_output') showToast(msg.data, 'info');
  });
}

export function unmount() {
  // Always clean up subscriptions
  if (_wsUnsub) { _wsUnsub(); _wsUnsub = null; }
}
```

### Injected helpers

| Helper | Description |
|---|---|
| `api` | Full Shipyard API client (`api.getServers()`, `api.getServer(id)`, etc.) |
| `pluginApi` | Namespaced client — `pluginApi.request('/path')` calls `/api/plugin/<id>/path` |
| `state` | Global app state: `state.servers`, `state.plugins`, `state.whiteLabel` |
| `navigate` | Navigate within Shipyard. Prefer core routes such as `/`, `/servers`, `/playbooks`, and `/settings`. |
| `showToast` | `(message, type)` — show a toast. `type`: `'info'` \| `'success'` \| `'warning'` \| `'error'` |
| `showConfirm` | `(message, opts) => Promise<boolean>` — show a confirmation dialog |
| `onWsMessage` | `(callback) => unsubscribeFn` — listen to WebSocket messages from the backend |

### Sending WebSocket messages to the frontend

Call `broadcast(data)` from your backend. `data` must be a plain object. The `type` field identifies the message:

```js
// index.js
broadcast({ type: 'my_plugin_done', result: 'success' });

// ui.js
_wsUnsub = onWsMessage(msg => {
  if (msg.type === 'my_plugin_done') showToast('Done!', 'success');
});
```

## Reference: OpenTofu Plugin

The built-in OpenTofu plugin (`/app/plugins/opentofu/`) is a complete real-world example. It demonstrates:

- Backend: SQLite table creation, file system access, spawning long-running processes, streaming output via `broadcast`
- Frontend: tabs, a file tree, a CodeMirror editor, terminal output rendering
- Docker: mounting workspace directories via `docker-compose.yml`

## Security

Plugins run as **Node.js code on the server** with full access to the file system, SSH connections, the Shipyard database, and the network.

- Only install plugins from sources you trust completely.
- Shipyard shows a security warning dialog when you enable a plugin for the first time.
- Plugin routes inherit Shipyard's JWT auth middleware — unauthenticated requests are rejected before reaching plugin code.

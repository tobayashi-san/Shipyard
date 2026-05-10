# Plugin System

## Overview

Shipyard supports plugins to extend functionality. Plugins can add backend API routes, database tables, frontend UI pages, or a combination of these.

Plugins run inside the Shipyard server process. Treat plugin code as trusted code.

## Included Plugins

### OpenTofu

Manage OpenTofu / Terraform workspaces and run infrastructure-as-code commands.

- Create and manage IaC workspaces
- File editor for `.tf` files
- Run `init`, `validate`, `plan`, `apply`, `destroy`
- Live output streaming
- State inspection
- Git sync for `.tf` files
- Auto-install OpenTofu binary

## Plugin Structure

Each plugin lives in `/app/plugins/{pluginId}/`:

```text
plugins/
└── my-plugin/
    ├── manifest.json    # Required: metadata
    ├── index.js         # Optional: backend (CommonJS)
    └── ui.js            # Optional: frontend (ES module)
```

### manifest.json

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "What this plugin does.",
  "sidebar": {
    "icon": "fas fa-cube",
    "label": "My Plugin"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier. Must match the directory name. Lowercase `a-z`, `0-9`, `-`, `_` only. |
| `name` | Yes | Human-readable name |
| `version` | Yes | Semver version |
| `description` | Yes | Short description |
| `sidebar.icon` | No | Common Font Awesome-style icon hint. Unknown values fall back to a puzzle icon. |
| `sidebar.label` | No | Sidebar menu label |

Recognized sidebar icon hints include `fa-cube`, `fa-terminal`, `fa-server`, `fa-shield`, `fa-cubes`, `fa-network`, `fa-anchor`, and `fa-ship`.

### index.js (Backend)

CommonJS module that exports a `register` function:

```javascript
function register({ router, db, broadcast, sshManager, ansibleRunner, scheduler, pluginId, pluginDir }) {
  router.get('/status', (req, res) => {
    res.json({ ok: true, pluginId });
  });
}

module.exports = { register };
```

Plugin routes are mounted at:

```text
/api/plugin/{pluginId}/...
```

Shipyard authentication middleware is applied before plugin routes.

**Available context:**

| Helper | Type | Description |
|--------|------|-------------|
| `router` | Express Router | Pre-mounted at `/api/plugin/{pluginId}`. Auth middleware applied automatically. |
| `db` | Object | Full database API. Use `db.db` for raw better-sqlite3 `prepare()` calls when needed. |
| `broadcast` | Function | `broadcast(data)` sends a WebSocket message to connected clients. |
| `sshManager` | Object | SSH key management and connection utilities. |
| `ansibleRunner` | Object | Run playbooks and ad-hoc Ansible commands. |
| `scheduler` | Object | Background polling scheduler. |
| `pluginId` | String | Current plugin ID. |
| `pluginDir` | String | Absolute plugin directory path. |

### ui.js (Frontend)

ES module that exports `mount` and optionally `unmount`:

```javascript
let _wsUnsub = null;

export async function mount(container, { api, pluginApi, navigate, showToast, showConfirm, onWsMessage }) {
  container.textContent = 'Loading...';

  const status = await pluginApi.request('/status');
  const servers = await api.getServers();

  container.innerHTML = `
    <div>
      <h2>My Plugin</h2>
      <p>Status: ${status.ok ? 'ready' : 'failed'}</p>
      <p>${servers.length} server(s)</p>
    </div>
  `;

  _wsUnsub = onWsMessage(msg => {
    if (msg.type === 'my_plugin_output') showToast(msg.data, 'info');
  });
}

export function unmount() {
  if (_wsUnsub) { _wsUnsub(); _wsUnsub = null; }
}
```

**Available helpers:**

| Helper | Description |
|--------|-------------|
| `api` | Main app API client. |
| `pluginApi` | Namespaced API: `pluginApi.request('/path')` calls `/api/plugin/{id}/path`. |
| `navigate` | Navigate within Shipyard. Prefer core routes such as `/`, `/servers`, `/playbooks`, and `/settings`. |
| `showToast` | `showToast(message, type)` shows a notification toast. |
| `showConfirm` | Shows a confirmation dialog and returns a Promise. |
| `onWsMessage` | Subscribe to WebSocket messages. Returns an unsubscribe function. |
| `state` | App state object. |

Always clean up timers, event listeners, and WebSocket subscriptions in `unmount()`.

## Installing Plugins

1. Create the plugin directory: `mkdir -p plugins/my-plugin`
2. Add `manifest.json`, `index.js`, and/or `ui.js`
3. Restart Shipyard or use **Settings > Plugins > Reload** for hot reload
4. Enable the plugin in **Settings > Plugins**

Docker Compose example:

```yaml
services:
  shipyard:
    volumes:
      - ./plugins:/app/plugins
```

## Enabling / Disabling

- **Settings > Plugins** toggles plugins on/off.
- Disabled plugins do not appear in the sidebar and their API routes are blocked.
- State is stored in `app_settings` as `plugin_{id}_enabled`.

## Plugin Permissions

Users can be restricted to specific plugins via RBAC:

- Role settings: `plugins: 'all'` or `['plugin-id-1', 'plugin-id-2']`
- Users without access to a plugin do not see it in the sidebar.

## Hot Reload

Plugins can be reloaded without restarting the server:

- **Settings > Plugins > Reload**
- API: `POST /api/plugins/reload`

This clears the Node.js require cache and re-executes `register()`. It is useful during development.

## Security

Plugins run as Node.js code with server-side privileges. They can access helper APIs for SSH, Ansible, database operations, filesystem paths, and WebSocket broadcasts. Only install and enable trusted plugins.


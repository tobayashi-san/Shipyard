# Plugin System

Plugins extend Shipyard with backend routes, frontend UI, or both.

## Runtime Location

Runtime plugins live in:

```text
/app/plugins/<plugin-id>/
```

For Docker Compose:

```yaml
services:
  shipyard:
    volumes:
      - ./plugins:/app/plugins
```

Bundled plugins are copied into `/app/plugins` on first start and updated when their bundled version changes.

## Plugin Structure

```text
my-plugin/
├── manifest.json
├── index.js
├── ui.js
├── src/
├── assets/
├── public/
└── dist/
```

`manifest.json` is required. `index.js` and `ui.js` are optional, but at least one should exist.

## manifest.json

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "Short description shown in Settings > Plugins.",
  "author": "Your Name",
  "sidebar": {
    "icon": "fas fa-cube",
    "label": "My Plugin"
  }
}
```

The `id` must match the directory name. It may contain lowercase letters, numbers, dashes, and underscores.

Recognized sidebar icon hints include `fa-cube`, `fa-terminal`, `fa-server`, `fa-shield`, `fa-cubes`, `fa-network`, `fa-anchor`, and `fa-ship`. Unknown icons fall back to a puzzle icon.

## Backend Routes

Backend routes are mounted at:

```text
/api/plugin/<plugin-id>/
```

They inherit Shipyard authentication middleware.

```js
function register({ router, db, broadcast, sshManager, ansibleRunner, scheduler, pluginId, pluginDir }) {
  router.get('/status', (req, res) => {
    res.json({ ok: true, pluginId });
  });
}

module.exports = { register };
```

## Frontend UI

`ui.js` exports `mount()` and optionally `unmount()`:

```js
export async function mount(container, { api, pluginApi, showToast, onWsMessage }) {
  container.textContent = 'Loading...';
  const status = await pluginApi.request('/status');
  container.textContent = status.ok ? 'Plugin ready' : 'Plugin failed';
}

export function unmount() {}
```

Always clean up timers, event listeners, and WebSocket subscriptions in `unmount()`.

`ui.js` may import frontend files relative to the plugin directory:

```js
import { ensureStyles } from './src/styles.js';
import './assets/plugin.css';
```

Shipyard serves imported frontend assets only for enabled plugins. Supported public paths are root-level frontend modules and files below `src/`, `assets/`, `public/`, or `dist/`. Supported file types are `.js`, `.mjs`, `.css`, `.svg`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.ico`, `.woff`, `.woff2`, `.ttf`, and `.wasm`.

Backend/private files are not served as plugin UI assets. Keep secrets and runtime data out of frontend folders. Root files such as `index.js`, `manifest.json`, package files, hidden files, `node_modules/`, `data/`, `private/`, `secrets/`, `server/`, and `storage/` stay private.

## Security

Plugins run with full server-side privileges. Only install and enable plugins you trust.

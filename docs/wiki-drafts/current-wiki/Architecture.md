# Architecture

## Overview

```text
┌──────────────────────────────────────────────────────────────┐
│  Browser                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐ │
│  │ React/Vite   │  │ WebSocket    │  │ Plugin UIs         │ │
│  │ frontend     │  │ live data    │  │ ES modules         │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬─────────────┘ │
└─────────┼─────────────────┼─────────────────┼───────────────┘
          │ REST API        │ WS/WSS          │ /plugins/:id/ui.js
          ▼                 ▼                 ▼
┌──────────────────────────────────────────────────────────────┐
│  Node.js / Express Server                                    │
│  ┌────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────────┐ │
│  │ Auth   │ │ Routes   │ │ Plugins  │ │ WebSocket Server  │ │
│  │ JWT    │ │ REST     │ │ CommonJS │ │ ws library        │ │
│  └────┬───┘ └────┬─────┘ └────┬─────┘ └────────┬──────────┘ │
│       │          │            │                │            │
│  ┌────▼──────────▼────────────▼────────────────▼──────────┐ │
│  │ Services                                                │ │
│  │ SSH manager, Ansible runner, scheduler, agent processor,│ │
│  │ notifier, git sync, plugin loader, system info helpers  │ │
│  └─────────────────────────────────────────────────────────┘ │
│                            │                                 │
│  ┌─────────────────────────▼───────────────────────────────┐ │
│  │ SQLite (better-sqlite3, WAL mode)                       │ │
│  │ servers, users, roles, schedules, settings, audit_log...│ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
          │
          │ SSH + HTTPS agent API
          ▼
┌──────────────────┐
│ Managed Servers  │
│ Linux hosts      │
└──────────────────┘
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite, TypeScript, TanStack Router/Query, plain plugin ES modules |
| Backend | Node.js 20, Express 4, CommonJS |
| Database | SQLite via better-sqlite3, WAL mode, foreign keys |
| Auth | JWT, bcrypt, TOTP |
| Automation | Ansible playbooks and ad-hoc commands |
| SSH | node-ssh / ssh2, Ed25519 keys |
| Scheduler | node-cron |
| Real-time | WebSocket via `ws` |
| Agent transport | HTTPS manifest/report API under `/api/v1/agent` |
| Plugins | CommonJS backend modules plus frontend ES modules |

## Request Flow

### REST API Request

```text
Browser -> HTTPS -> Express -> Auth Middleware -> Route Handler -> DB/Service -> Response
```

1. Auth middleware extracts JWT from `Authorization: Bearer <token>`.
2. It verifies the signature with `JWT_SECRET` and checks `token_version`.
3. It attaches `req.user`.
4. Route-specific middleware checks capabilities or admin status.
5. Server-specific routes use permission filters so restricted users only access allowed servers.

### WebSocket Connection

```text
Browser -> WSS -> Token verification -> Client registered -> Permission-filtered broadcasts
```

Messages containing a `serverId` are filtered so users only receive events for servers they can access.

### Ansible Execution

```text
Route/Schedule -> AnsibleRunner -> Inventory -> SSH key -> ansible-playbook -> WebSocket output -> History
```

1. Dynamic inventory is generated from the `servers` table.
2. SSH key is decrypted to a temporary location when needed.
3. `ansible-playbook` is spawned as a child process.
4. stdout/stderr stream through WebSocket.
5. Result and output are stored in history tables.
6. Temporary files are cleaned up in `finally` blocks.

### Agent Metrics Flow

```text
Runner on server -> HTTPS /api/v1/agent/report -> processIncomingReport() -> agent_metrics + server_info cache
```

Agent data supplies system metrics. OS/package/docker/custom update checks still use SSH/Ansible.

## Directory Structure

```text
/app/
├── frontend-next/
│   ├── src/
│   │   ├── main.tsx
│   │   ├── router.tsx
│   │   ├── lib/
│   │   ├── components/
│   │   └── routes/
│   └── dist/                  # Built frontend served in production
│
├── server/
│   ├── index.js               # Startup, HTTP/HTTPS server, WebSocket hub
│   ├── app.js                 # Express app and routes
│   ├── db/                    # SQLite schema, queries, migrations
│   ├── middleware/
│   ├── routes/
│   ├── services/
│   ├── utils/
│   ├── data/                  # Runtime data in Docker
│   └── playbooks/             # Bundled/user playbooks depending on runtime path
│
├── plugins/
│   └── opentofu/
│       ├── manifest.json
│       ├── index.js
│       └── ui.js
│
└── plugin-template/
```

In Docker, runtime paths are:

| Path | Purpose |
|---|---|
| `/app/server/data` | SQLite DB, generated certs, cache, internal state |
| `/app/server/playbooks` | User-visible playbooks |
| `/app/plugins` | Runtime plugins |
| `/app/bundled-plugins` | Image-bundled plugin source copied into `/app/plugins` |
| `/app/bundled-playbooks` | Image-bundled starter/system playbooks |

## Database Schema

All tables use TEXT primary keys. Key tables:

| Table | Purpose |
|-------|---------|
| `servers` | Server inventory |
| `server_info` | Cached system metrics per server |
| `server_groups` | Hierarchical groups |
| `users` | Authentication records |
| `roles` | RBAC role definitions |
| `schedules` | Cron-scheduled playbook runs |
| `schedule_history` | Execution log with output |
| `update_history` | Ad-hoc update operation log |
| `custom_update_tasks` | User-defined version checks |
| `ansible_vars` | Global Ansible variables |
| `audit_log` | Security audit trail |
| `app_settings` | Key-value configuration store |
| `docker_containers` | Container metadata cache |
| `compose_projects` | Discovered Compose projects |
| `agent_config` | Agent mode/token/url/interval and last_seen per server |
| `agent_metrics` | Raw agent reports |
| `agent_manifests` | Versioned agent collector manifests |

## Real-Time Updates

WebSocket messages broadcast from server to permitted clients:

| Message Type | Trigger |
|-------------|---------|
| `cache_updated` | Background poller refreshed server info |
| `update_output` / `update_complete` | Package update running/done |
| `ansible_output` / `ansible_complete` | Playbook execution |
| `compose_output` | Docker Compose action |
| `bulk_update_output` / `bulk_update_complete` | Multi-server update |
| `tofu_output` / `tofu_done` | OpenTofu plan/apply plugin events |


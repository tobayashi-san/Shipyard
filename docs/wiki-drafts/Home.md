# Shipyard Wiki

Shipyard is a web dashboard for managing Linux servers with SSH, Ansible, Docker/Compose, update checks, schedules, audit logging, and plugins.

## Start Here

- [Installation](Installation)
- [Configuration](Configuration)
- [Security Guide](Security-Guide)
- [Server Management](Server-Management)
- [Playbooks and Schedules](Playbooks-and-Schedules)
- [Docker Management](Docker-Management)
- [Plugin System](Plugin-System)
- [Troubleshooting](Troubleshooting)

## Current Architecture

- Backend: Node.js, Express, SQLite, WebSocket, Ansible runner, SSH manager
- Frontend: React/Vite build served from `frontend-next/dist`
- Runtime data: `/app/server/data`
- User playbooks: `/app/server/playbooks`
- Runtime plugins: `/app/plugins`
- Bundled plugins: seeded into `/app/plugins` on first start and updated when their bundled version changes

## Container Images

Images are published to GitHub Container Registry:

- Stable: `ghcr.io/tobayashi-san/shipyard:latest`
- Versioned: `ghcr.io/tobayashi-san/shipyard:<version>`
- Release candidates: `ghcr.io/tobayashi-san/shipyard:<version>-rc.<n>`

`latest` tracks stable releases only. Release candidates must be pinned explicitly.


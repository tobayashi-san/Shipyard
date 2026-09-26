# Docker deployment

Fleet manages SSH credentials and can run automation on your hosts. Deploy
it only on a trusted network: behind a VPN, a firewall, or a reverse proxy.
Do not publish its port directly to the public internet.

## Quick start

Download the version-controlled `docker-compose.yml` into an empty directory and
start it:

```bash
mkdir fleet && cd fleet
curl -fsSLO https://raw.githubusercontent.com/tobayashi-san/Fleet/main/docker-compose.yml
docker compose up -d --wait
docker compose ps
```

No `.env` file is required. On its first start, the container generates
`JWT_SECRET` and `FLEET_KEY_SECRET` and stores them in
`/app/secrets/fleet.env`, a root-only file in the `fleet-secrets` volume.
The secrets volume is separate from the data volume, so application backups of
`/app/server/data` never contain the key that decrypts them.

`FLEET_KEY_SECRET` encrypts stored SSH keys, tokens, and TOTP secrets, and
must stay the same for the lifetime of the installation. Copy it somewhere safe,
apart from your data backups:

```bash
docker compose exec fleet cat /app/secrets/fleet.env
```

### Secrets and `.env`

To change defaults such as the port or bind address, create a private `.env`
next to `docker-compose.yml`. `.env.example` lists the available settings:

```bash
curl -fsSLO https://raw.githubusercontent.com/tobayashi-san/Fleet/main/.env.example
cp .env.example .env
chmod 600 .env
```

`JWT_SECRET` and `FLEET_KEY_SECRET` set in `.env` always take precedence
over the generated values. Existing installations that already define them in
`.env` must keep them. If the database already exists but no key is available
from `.env` or the secrets volume, the container refuses to start rather than
generating a new key that could not decrypt the stored credentials.

The default binding is `127.0.0.1:443`, so Fleet is accessible only from
the Docker host or a reverse proxy on that host. Open
`https://localhost` and complete onboarding. Fleet creates a self-signed
certificate on its first start.

## Network and TLS

For direct access from a protected LAN, set an explicit private host address
in `.env`, for example:

```dotenv
FLEET_BIND_ADDRESS=10.20.1.10
CERT_SANS=IP:10.20.1.10,DNS:fleet.example.internal
```

Never use `0.0.0.0` unless an external firewall strictly limits access. For a
reverse proxy, keep the localhost binding and configure the proxy to terminate
TLS. Mount a certificate and key read-only when Fleet should serve your own
certificate directly:

```yaml
volumes:
  - /etc/ssl/certs/fleet.crt:/certs/fleet.crt:ro
  - /etc/ssl/private/fleet.key:/certs/fleet.key:ro
environment:
  - SSL_CERT=/certs/fleet.crt
  - SSL_KEY=/certs/fleet.key
  - ALLOWED_ORIGINS=https://fleet.example.internal
  - TRUST_PROXY=1 # only when a trusted reverse proxy is in front of Fleet
```

`CERT_SANS` is especially important for agent push mode: managed hosts must be
able to verify Fleet's certificate name or IP address.

### Renewing a generated certificate

Changing `CERT_SANS` does not silently replace an existing certificate. To
explicitly renew Fleet's generated certificate, set the new `CERT_SANS` and
`FLEET_RENEW_CERT=1` in `.env`, then run `docker compose up -d --wait`.
After successful renewal, set `FLEET_RENEW_CERT=0` and run the same command
again. Leaving renewal enabled would generate a new key on every container start.

The previous generated key/certificate pair is retained under
`/app/server/data/certs/previous.*`. A failed generation leaves the current
pair intact. Renewal changes the self-signed certificate's identity: update
browser and managed-agent trust as needed. Old certificates without SANs,
expired certificates, and incomplete or mismatched pairs stop startup with a
diagnostic instead of being silently replaced.

Custom certificates are never renewed by this setting. Set both `SSL_CERT` and
`SSL_KEY`, mount the files read-only, and make them readable by container UID
1001. Setting only one path or combining custom TLS with generated-certificate
renewal stops startup.

### Runtime settings

The supplied Compose file forwards MFA policy, both SSH terminal time limits,
plugin trust policy/digests, and the renewal flag from `.env` to the application.
Changes require `docker compose up -d --wait` to recreate the container; a plain
restart does not reload its environment. `.env.example` lists these settings.
Compose uses `.env` for interpolation, not as an automatic container env file.
Additional application variables require explicit `environment` entries.

Startup repairs ownership of `/workspaces` by default. For custom container
paths, mount the directories and explicitly set `OPENTOFU_WORKSPACE_ROOTS` in
the service environment to their comma-separated absolute paths. Use dedicated
paths such as `/mnt/fleet-workspaces`; system paths are rejected. Symlinks
inside a workspace are not followed during recursive ownership repair. The old
application-written `tofu-workspace-paths.txt` is no longer used for root-level
ownership changes.

## Persistent data and backups

The named `fleet-data` volume contains the SQLite database, TLS material,
encrypted secrets, SSH keys, and the OpenTofu binary installed from the
Deployments page (`bin/tofu`). OpenTofu deployment files and state are kept in
the separate `fleet-workspaces` volume. The container automatically repairs
workspace ownership on startup, including when `/workspaces` is replaced with
a writable bind mount. The local `./playbooks` and `./plugins` directories are
also mounted and should be backed up if you customize them.

On upgrades, obsolete `/app/plugins/opentofu` and the old user-mounted
`playbooks/system` directory are moved into
`/app/server/data/legacy-migrations/startup.*`. Their contents are preserved for
manual inspection and recovery rather than deleted. Do not copy an obsolete
plugin back into the active plugin directory; restore only reviewed custom
content. These archives are part of the data volume and should be included in
its backup.

Fleet also provides [encrypted database exports](database-backup.md) and an
[offline application recovery package](application-backup.md). Database exports
do not include all deployment files. Preserve the original deployment secrets
separately and consult the recovery guide for package coverage and activation
limits. The volume command below archives only `fleet-data`; workspaces,
custom playbooks, plugins, and external configuration need separate coverage.

For a consistent volume backup, stop Fleet first, then archive the named
volume. Replace `fleet_fleet-data` with the volume name shown by
`docker volume ls` if your Compose project has another name.

```bash
docker compose stop
docker run --rm \
  -v fleet_fleet-data:/data:ro \
  -v "$PWD":/backup \
  alpine:3.21 tar -C /data -czf /backup/fleet-data-$(date +%F).tgz .
docker compose start
```

Protect the backup like a secret: it contains encrypted data and the key
material needed to decrypt it. Test a restore on a non-production host before
depending on a backup.

## Updating

Pin a release tag in `.env` for predictable production updates:

```dotenv
FLEET_IMAGE=ghcr.io/tobayashi-san/fleet:3.0
```

After taking a backup, update with:

```bash
docker compose pull
docker compose up -d --wait
docker image prune -f
```

The named data volume is preserved. Do not use `docker compose down -v` unless
you intentionally want to delete all Fleet data.

The sidebar shows the running version and points out when a newer stable
release is published. Fleet asks the public GitHub release list at most every
six hours and sends nothing about your installation. Set
`FLEET_UPDATE_CHECK=0` in `.env` to turn the check off, for
example on hosts without internet access.

## Security properties of the supplied Compose stack

- No privileged mode or host Docker socket is mounted.
- The image initializes data as root only when needed, then runs the server as
  the unprivileged `fleet` user.
- `no-new-privileges` prevents child processes from gaining extra privileges.
- Docker's local log driver limits each container log to three 10 MB files.
- Generated secrets stay in a root-only, mode-600 file in their own volume; the
  application process receives them only through its environment. Secrets you
  set yourself stay in the ignored, mode-600 `.env` file; `.env.example`
  contains only empty placeholders.

Validate the final configuration before starting it:

```bash
docker compose config --quiet
```

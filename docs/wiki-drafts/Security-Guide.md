# Security Guide

Shipyard stores SSH keys and can execute commands on managed servers. Do not expose it directly to the public internet.

## Recommended Deployment

- Run Shipyard on a private network or VPN.
- Use HTTPS.
- Set `JWT_SECRET` and `SHIPYARD_KEY_SECRET`.
- Restrict access with a firewall or reverse proxy.
- Enable TOTP/2FA for admin accounts.
- Give users the minimum role/capabilities they need.
- Install plugins only from trusted sources.

## Secrets

`JWT_SECRET` signs browser sessions. In production, Shipyard refuses to start without it.

`SHIPYARD_KEY_SECRET` encrypts stored secrets. Keep it stable and backed up. If it is lost or changed, previously encrypted SSH keys and TOTP secrets cannot be decrypted.

## TLS and Agents

The Docker image creates a self-signed TLS certificate when no custom certificate is mounted. For agent push/auto mode, include the address used by managed servers in `CERT_SANS`:

```yaml
environment:
  - CERT_SANS=IP:10.30.1.10,DNS:shipyard.example.com
```

## Reverse Proxy

When Shipyard is behind a reverse proxy, set:

```yaml
environment:
  - TRUST_PROXY=1
  - ALLOWED_ORIGINS=https://shipyard.example.com
```

Only set `TRUST_PROXY` when the proxy is trusted and controls the forwarded headers.

## Plugins

Plugins run as Node.js code inside the Shipyard server process and have access to SSH helpers, database helpers, filesystem paths, and network access. Only enable trusted plugins.


# Security & Robustness Review — Design-Report

Dies sind Review-Findings, die **bewusst nicht als Code-Change umgesetzt** wurden. Gründe: Trade-off, Scope-Größe, oder Product-Entscheidung nötig.

Format pro Punkt: Risiko / aktuelle Mitigation / empfohlene Folgemaßnahme.

---

## Critical

### C5 — JWT in `localStorage` + fehlende Content Security Policy

**Risiko.** XSS in einer Plugin-UI, einer Markdown-Renderung oder einer Third-Party-Lib kann das Session-Token aus `localStorage` auslesen und exfiltrieren. Shipyard führt privilegierte Aktionen aus (SSH, Ansible, Compose, JWT-Rotation) — ein gestohlenes Admin-Token kompromittiert die gesamte Flotte.

**Aktuelle Mitigation.**
- Frontend sanitized mit `textContent`/`esc`/DOMPurify (siehe AGENTS.md).
- JWT-Rotation via `POST /api/system/rotate-jwt-secret` invalidiert alle Sessions.
- `token_version` pro User erlaubt gezieltes Invalidieren.

**Empfehlung (eigenes Ticket).**
1. Token-Speicher auf `HttpOnly; Secure; SameSite=Strict` Cookie umstellen.
2. CSRF-Schutz ergänzen (Double-Submit-Cookie oder Origin-Check).
3. CSP-Header setzen: `default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'`.
4. Plugin-UIs in Sandbox-iframe isolieren (siehe H6).

**Warum nicht jetzt.** Berührt Auth-Layer, alle Frontend-Fetches, Plugin-Contract. Eigener PR mit Migrationspfad nötig.

---

## High

### H6 — Plugin-Loader ohne Capability-Gating

**Risiko.** Plugins laufen mit vollem Backend-Prozess-Zugriff: `require('../db')`, `require('fs')`, Netzwerk, SSH-Manager. Ein schadhaftes oder kompromittiertes Plugin kann die gesamte DB lesen, Secrets entschlüsseln, beliebige SSH-Commands absetzen.

**Aktuelle Mitigation.**
- Plugin-Installation ist admin-only.
- Plugins werden aus `PLUGINS_DIR` geladen — kein Remote-Fetch zur Laufzeit.

**Empfehlung (Plugin-API v2, eigenes Ticket).**
- Capability-Deklaration in `plugin.json` (`caps: ["servers.read", "ansible.run"]`).
- Loader injiziert nur gemappte Facade-Objekte statt `require('../db')`.
- Plugin-UI in sandboxed iframe mit `postMessage`-Bridge.
- Signierte Plugin-Manifeste (optional).

**Warum nicht jetzt.** Breaking Change für alle bestehenden Plugins. Dedizierte RFC + Migrationsstrategie erforderlich.

---

### H7 — User-Row Secret-Leak-Risiko

**Risiko.** `db.users.getByUsername()` liefert `password_hash` und `totp_secret` (encrypted nach C4) zurück. Ein zukünftiger Handler könnte das User-Objekt aus Versehen als Response serialisieren.

**Aktuelle Mitigation.**
- Alle derzeitigen Callsites wurden überprüft — kein aktiver Leak.
- `totp_secret` ist seit C4 AES-256-GCM encrypted (`enc:` prefix).
- `getById`/`getAll` liefern bereits nur safe-Spalten.

**Empfehlung (eigenes Ticket).**
- `getByUsername` → safe-Spalten; neue `getAuthByUsername` mit Secrets für Auth-Code.
- Default opt-out: Auth-Callsites müssen explizit auth-Variante anfordern.

**Warum nicht jetzt.** 5 bestehende Tests codifizieren den aktuellen `getByUsername`-Full-Row-Contract direkt (`assert.ok(u.password_hash)`, `assert.match(row.totp_secret, /^enc:/)`). Der Refactor berührt DB-Modul + 4 auth-Callsites + 4 Testfiles — das überschreitet AGENTS.md "minimal diffs". Kein aktiver Leak → separates Ticket.

---

## Medium

### M2 (Teil) — Admin-only stderr in Responses

**Risiko.** Endpoints `agent-admin.js`, `git-playbooks.js`, `server-actions.js`, `ansible.js` geben `stderr` direkt an Admin-UI zurück. Theoretisch: Pfade, Token-Fragmente, interne Hostnamen exposed.

**Aktuelle Mitigation.**
- Nur Admin-Scope.
- H2 hat Git-URL-Validation hinzugefügt → Token-in-URL-Leaks reduziert.
- `serverError()` Helper wird für 500er benutzt; stderr ist bewusst Teil der Operator-UX.

**Empfehlung.** Keine Änderung. Operator-Debugging-Wert überwiegt Risiko bei Admin-only Endpoints. Bei Öffnung für non-admin Rollen: stderr scrubben.

---

### M6 — Webhook Response Slow-Drip (BEHOBEN)

**Update.** Ursprünglich als "OOM-Risiko" gemeldet — Code-Re-Read zeigte: `res.resume()` drained bereits ohne Buffering, kein OOM. Tatsächliches Restrisiko war Slow-Drip (bösartiger Endpoint hält Connection per Byte-Trickle offen). Behoben: Response-Body jetzt gecappt auf 64 KB, hard abort danach. `resolve`-Race durch `settled`-Guard geschützt.

---

### M7 — `parseInt` ohne Radix (BEHOBEN)

**Update.** 30 Callsites via `perl -pi -e` auf `parseInt(x, 10)` umgestellt. Null Laufzeitverhalten-Änderung in ES5+, reine Robustheit gegen hypothetische Legacy-Oktal-Interpretation.

---

### M8 — `TRUST_PROXY` binär (BEHOBEN)

**Update.** `app.js` akzeptiert jetzt: `'1'`/`'0'` (wie bisher), numerische Hop-Counts (`'2'`, `'3'`), `'true'`/`'false'`, und Comma-separated IP/CIDR-Listen. Backward-compatible zu `'1'`-only.

---

### M9 — Docker-Compose Pfad-Allowlist

**Risiko.** `/api/compose/write` akzeptiert einen Pfad zum Schreiben von `docker-compose.yml`. Aktuell per `canManageCompose`-Capability gegated, aber kein Pfad-Allowlist — Admin könnte beliebige Pfade auf Zielsystem schreiben (via SSH).

**Aktuelle Mitigation.**
- Capability-gated (admin-Rolle).
- Path-Traversal im Dateinamen wird in `utils/validate.js` geblockt.
- Schreibt auf Zielserver, nicht Shipyard-Host — Blast-Radius auf Zielsystem begrenzt.

**Empfehlung.** Optional: Settings-Feld `allowed_compose_paths` (Globs), Default `/opt/**`,`/srv/**`,`~/compose/**`. Bei Bedarf einführen.

**Warum nicht jetzt.** Admin mit `canManageCompose` hat ohnehin SSH-Exec-Capability → kein Escalation-Path. Pfad-Allowlist wäre Defense-in-Depth.

---

### M11 — Adhoc shell/command/raw ohne Allowlist

**Risiko.** `/api/adhoc` erlaubt Admins beliebige Shell-Commands auf gewählten Servern. Komplett vertraut.

**Aktuelle Mitigation.**
- Capability `canRunAdhoc` (admin-default).
- Audit-Log für jede Ausführung.
- Rate-Limit.

**Empfehlung (Product-Entscheidung nötig).** Optional: Command-Allowlist/Blocklist pro Rolle, Genehmigungs-Workflow, Preview-Mode. Ist Shipyard ein Operator-Werkzeug (volle Freiheit) oder ein Delegate-Tool (restricted)?

**Warum nicht jetzt.** Produkt-Scope-Entscheidung. AGENTS.md: "keine Rolle-/API-Umbauten ohne expliziten Auftrag".

---

## Nicht mehr relevant

### M10 — `validateTargets` Length-Cap

Während der Review entdeckt: Cap (500 Zeichen) existiert bereits in `server/utils/validate.js`. Finding war ungenau. Kein Fix nötig.

---

## Zusammenfassung

| Schweregrad | Behoben | Design-Report |
|---|---|---|
| Critical | C1, C2, C3, C4 | C5 |
| High | H1, H2, H3, H4, H5, H8, H9 | H6, H7 |
| Medium | M1, M3, M4, M5, M6, M7, M8, M10, M12 | M2 (partial), M9, M11 |

**Tests:** 234 grün (+38 neue Tests seit Review-Start).

**Tickets für Folge-PRs (empfohlen):**
1. C5 — HttpOnly-Cookie-Auth + CSP + CSRF
2. H6 — Plugin-API v2 mit Capabilities + Sandbox
3. H7 — User-DB-Layer Split (auth vs. public)
4. M6 — Notifier Response-Body Cap (Quick-Win, 5 Zeilen)
5. M11 — Adhoc-Command Policy (Product-Diskussion)

# Encrypted database backups

This is the database portion of Fleet recovery. It is not a full system backup or an automated application recovery workflow.

The snapshot includes every SQLite table across all environments, including users, configuration, inventory, history and database-stored credentials. SQLite's online backup API includes committed WAL data in a consistent snapshot. Creation checks SQLite integrity before encrypting the snapshot with AES-256-GCM and a random salt/nonce; the passphrase key is derived with scrypt. Verification authenticates the archive before checking the extracted database. Existing destination files are never overwritten.

Preserve these separately:

- The original `FLEET_KEY_SECRET`, needed to decrypt application secrets after recovery. The backup passphrase does not replace it. When Fleet generated it, it is in `/app/secrets/fleet.env` in the `fleet-secrets` volume.
- The deployment configuration and any externally configured JWT secret.
- User playbooks, plugins, Git workspace and infrastructure state files/directories, including paths configured outside the default data volume.
- Remote hosts, VMs, disks and application data. A Fleet database backup does not back them up.

Administrators can also create and download an encrypted database archive from Administration → Danger Zone. The export requires the current account password and, when enabled, a current authenticator code. Confirm that the scope includes all environments. The server keeps only a temporary archive for transfer; it does not retain a managed backup after download. Verify and store the downloaded file separately.

Run from the repository root on the application host with its installed Node dependencies. Use an absolute output filename in an existing private directory with enough free space for both the SQLite snapshot and encrypted archive. No production backup is created merely by installing this code.

```bash
read -rs -p 'Backup passphrase: ' FLEET_BACKUP_PASSPHRASE
export FLEET_BACKUP_PASSPHRASE
node server/cli/database-backup.js create /secure/backups/fleet-db.backup
unset FLEET_BACKUP_PASSPHRASE
```

Set `DB_PATH` when the deployment uses a nondefault database location. The CLI opens the database read-only. The passphrase must contain at least 12 characters and at most 1024 UTF-8 bytes; keep it separately in a password manager. It is passed through the environment, not a command-line argument. Output contains only scope, integrity, counts and size, not database values or passphrases.

Verify the archive with the same passphrase:

```bash
read -rs -p 'Backup passphrase: ' FLEET_BACKUP_PASSPHRASE
export FLEET_BACKUP_PASSPHRASE
node server/cli/database-backup.js verify /secure/backups/fleet-db.backup
unset FLEET_BACKUP_PASSPHRASE
```

Verification decrypts into a private temporary directory and removes it afterward. The archive and temporary snapshot use restrictive filesystem permissions. Temporary plaintext can exist while creation/verification runs; use trusted local storage and account permissions. A successful integrity check proves archive authentication and SQLite structural integrity, not full application recovery or availability of the separate files/keys listed above.

## Restore into a new database file

The restore command authenticates and verifies the archive, then publishes a new database file. It refuses to overwrite any existing destination, including symlinks, and refuses destinations with existing SQLite sidecar files. The source database and archive are unchanged. Restored versioned login tokens are invalidated by advancing each user's token version; tracked sessions and pending MFA-enrollment secrets are removed. Users must sign in again.

```bash
read -rs -p 'Backup passphrase: ' FLEET_BACKUP_PASSPHRASE
export FLEET_BACKUP_PASSPHRASE
node server/cli/database-backup.js restore /secure/backups/fleet-db.backup /secure/recovery/restored.db
unset FLEET_BACKUP_PASSPHRASE
```

Use an existing private recovery directory with sufficient free space. The output is a plaintext SQLite database protected by filesystem permissions; the archive remains encrypted. This command does not change `DB_PATH`, stop/start Fleet or activate the restored database.

Before application recovery, preserve the current deployment, stop application writers and restore the required files and original encryption key separately. Validate with the matching Fleet version in an isolated recovery environment. Restored schedules and integration settings retain their saved values, so do not start a second connected scheduler against production systems during verification. Never replace a running application's database or mix it with old WAL/SHM files.

Full filesystem packaging, coordinated activation/rollback, retention, restore UI, backup requirements before resets and end-to-end recovery acceptance remain pending.

## Recovery verification coverage

Automated tests restore the real Fleet schema into a separate process, retain records across two environments and an admin role, decrypt a stored setting with the original application key, reject an old tracked HTTP/WebSocket session, and complete a fresh password-plus-MFA login. The wrong application key cannot decrypt the setting or complete MFA. These tests use synthetic data and authentication modules only; they do not start schedulers or establish host connections and do not constitute full deployment recovery acceptance.

## Scheduled backups to a destination

Under **Settings → Backup → Scheduled backups** an administrator can add
destinations that receive the same encrypted, verified database archive on a
schedule: SMB shares, SFTP servers, S3-compatible buckets (AWS, Backblaze,
Wasabi, MinIO, Cloudflare R2 and others), Google Drive, WebDAV/Nextcloud, or a
folder inside the container that is mounted from the Docker host.

- Fleet copies archives with rclone. Remotes are passed to each rclone call as
  environment variables; no rclone configuration file is written.
- Credentials and the backup passphrase are stored encrypted with
  `FLEET_KEY_SECRET` and are never returned by the API. Leave a secret field
  empty when editing to keep the stored value.
- Adding a destination, and changing its location, credentials or passphrase,
  requires the current account password and authenticator code.
- Archives are named `fleet-database-YYYYMMDD-HHMMSS.backup`. After each upload
  Fleet deletes the oldest archives with that name pattern beyond the number to
  keep. Other files in the folder are never touched.
- A failed run is shown on the destination and sent through the configured
  notification channels.
- For Google Drive, run `rclone authorize "drive"` on a computer with a browser
  and paste the printed token JSON. Fleet uses the `drive.file` scope and only
  sees files it created.

Store the backup passphrase and `FLEET_KEY_SECRET` outside Fleet. Restore an
archive with the recovery CLI described above.

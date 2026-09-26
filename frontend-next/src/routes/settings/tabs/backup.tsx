import { DatabaseBackupCard } from '@/features/backup/DatabaseBackupCard';
import { BackupTargetsCard } from '@/features/backup/BackupTargetsCard';

export function BackupTab() {
  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">Fleet application data; infrastructure backups are managed externally. Keep the backup passphrase, FLEET_KEY_SECRET and deployment files outside Fleet: without them the archives cannot be restored.</p>
    <BackupTargetsCard />
    <DatabaseBackupCard />
  </div>;
}

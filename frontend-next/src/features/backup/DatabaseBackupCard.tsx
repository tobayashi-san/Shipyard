import {useQueryClient} from '@tanstack/react-query';
import {useRef,useState} from 'react';
import {apiDownload} from '@/lib/api';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Card,CardHeader,CardTitle,CardContent} from '@/components/ui/card';

export function DatabaseBackupCard() {
  const qc=useQueryClient();
  const [password,setPassword]=useState('');
  const [code,setCode]=useState('');
  const [passphrase,setPassphrase]=useState('');
  const [repeat,setRepeat]=useState('');
  const [confirmed,setConfirmed]=useState(false);
  const [pending,setPending]=useState(false);
  const [error,setError]=useState('');
  const [complete,setComplete]=useState(false);
  const inFlight=useRef(false);
  const passphraseBytes = new TextEncoder().encode(passphrase).length;
  const passphraseTooLong = passphraseBytes > 1024;
  const valid=confirmed && password.length>0 && passphrase.length>=12 && !passphraseTooLong && passphrase===repeat;
  async function download(event:React.FormEvent) {
    event.preventDefault();
    if (!valid || inFlight.current) return;
    inFlight.current=true;setPending(true);setError('');setComplete(false);
    try {
      await apiDownload('/system/database-backup',`fleet-database-${new Date().toISOString().slice(0,10)}.backup`,{body:{password,code,passphrase,scope:'all-environments-database'}});
      setComplete(true);
      void qc.invalidateQueries({queryKey:['recovery-status']});
    } catch(error) {setError(error instanceof Error ? error.message : 'Backup could not be created');}
    finally {setPassword('');setCode('');setPassphrase('');setRepeat('');setPending(false);inFlight.current=false;}
  }
  return <Card>
    <CardHeader><CardTitle>Encrypted database backup</CardTitle><p className="text-sm text-muted-foreground">Includes database records and stored credentials from all environments. Playbooks, Git workspace, infrastructure state files and remote workload data are not included.</p></CardHeader>
    <CardContent>
      <p className="mb-4 text-sm text-muted-foreground">The passphrase protects this archive but does not replace the original FLEET_KEY_SECRET. Restore into a new database with the server recovery CLI.</p>
      <form onSubmit={download} className="space-y-3">
        <fieldset disabled={pending} className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">Current account password<Input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required maxLength={1024}/></label>
          <label className="space-y-1 text-sm">Authenticator code (if enabled)<Input autoComplete="one-time-code" inputMode="numeric" value={code} onChange={e=>setCode(e.target.value)} maxLength={6}/></label>
          <label className="space-y-1 text-sm">Backup passphrase<Input type="password" autoComplete="new-password" value={passphrase} onChange={e=>setPassphrase(e.target.value)} required minLength={12} maxLength={1024} aria-invalid={passphraseTooLong || undefined} aria-describedby="backup-passphrase-help backup-passphrase-size"/></label>
          <label className="space-y-1 text-sm">Repeat backup passphrase<Input type="password" autoComplete="new-password" value={repeat} onChange={e=>setRepeat(e.target.value)} required maxLength={1024}/></label>
        </fieldset>
        <p id="backup-passphrase-help" className="text-xs text-muted-foreground">Use at least 12 characters, at most 1024 UTF-8 bytes. Store the passphrase separately; lost passphrases cannot be recovered. Secret fields are cleared after every attempt.</p>
        <p id="backup-passphrase-size" role={passphraseTooLong ? 'alert' : undefined} className={passphraseTooLong ? 'text-sm text-destructive' : 'text-xs text-muted-foreground'}>{passphraseTooLong ? `Passphrase is too long (${passphraseBytes} of 1024 bytes). Shorten it to continue.` : `${passphraseBytes} of 1024 bytes used.`}</p>
        {repeat && repeat!==passphrase && <p className="text-sm text-destructive">Backup passphrases do not match.</p>}
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={pending} onChange={e=>setConfirmed(e.target.checked)}/>I understand this exports the database for all environments and is only one part of a complete recovery backup.</label>
        <Button type="submit" className="h-auto w-full whitespace-normal py-2 sm:w-auto" disabled={!valid || pending}>{pending?'Preparing and verifying encrypted backup…':'Create and download database backup'}</Button>
        {error && <p role="alert" className="text-sm text-destructive">{error} Enter credentials again to retry.</p>}
        {complete && <p role="status" className="text-sm">Download started. The server verified decryption and database integrity before sending the archive. Keep it securely and verify the downloaded copy with the recovery CLI before relying on it.</p>}
      </form>
      <details className="mt-5 rounded-md border p-3 text-sm">
        <summary className="cursor-pointer font-medium">Verify a download and prepare a database restore</summary>
        <div className="mt-3 space-y-3">
          <p>Use a trusted recovery machine with the Fleet server tools and dependencies installed. Run these Bash commands from the Fleet project directory. Replace the example archive path with your downloaded file.</p>
          <p><strong>1. Verify the downloaded copy.</strong> Enter the backup passphrase at the hidden prompt. An exit code of 0 and <code>integrity: "ok"</code> confirm archive authentication and database integrity.</p>
          <pre className="overflow-x-auto rounded bg-muted p-3 text-xs"><code>{`read -rs -p 'Backup passphrase: ' FLEET_BACKUP_PASSPHRASE
export FLEET_BACKUP_PASSPHRASE
node server/cli/database-backup.js verify /secure/backups/database.backup
unset FLEET_BACKUP_PASSPHRASE`}</code></pre>
          <p><strong>2. Prepare a separate database.</strong> The destination file must not exist; its parent directory must exist. This leaves the current database untouched and invalidates copied versioned sessions.</p>
          <pre className="overflow-x-auto rounded bg-muted p-3 text-xs"><code>{`read -rs -p 'Backup passphrase: ' FLEET_BACKUP_PASSPHRASE
export FLEET_BACKUP_PASSPHRASE
node server/cli/database-backup.js restore /secure/backups/database.backup /secure/recovery/database.db
unset FLEET_BACKUP_PASSPHRASE`}</code></pre>
          <p><strong>3. Review before activation.</strong> Preserve the current deployment for rollback, stop application writers, and review the restored database together with the original application key, deployment configuration and separately backed-up files. Validate recovery in an isolated deployment before changing the production database path. These commands do not switch databases or restart Fleet.</p>
          <p>For a package containing application files as well as the database, use the offline application-backup procedure in <code>docs/application-backup.md</code>. Remote workloads still need their own backups. A successful verification here does not establish that a complete deployment can be recovered.</p>
        </div>
      </details>
    </CardContent>
  </Card>;
}

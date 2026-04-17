import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Key, Copy, Download, Upload, Send, CheckCircle2, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { SettingsRow, SettingsSection } from '../_row';

interface SSHKey {
  publicKey: string;
  exists?: boolean;
  name?: string;
}

export function SshTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const { data, isLoading, isError } = useQuery<SSHKey | null>({
    queryKey: ['ssh-key'],
    queryFn: async () => {
      try { return (await api.getSSHKey()) as SSHKey; }
      catch { return null; }
    },
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['ssh-key'] });

  return (
    <div className="space-y-6">
      <SettingsSection icon={<Key className="h-4 w-4" />} title={t('set.sshTitle')}>
        {isLoading ? (
          <SettingsRow label={t('set.sshStatus')} noBorder>
            <span className="text-sm text-muted-foreground">{t('common.loading')}</span>
          </SettingsRow>
        ) : data && data.publicKey ? (
          <SshKeyView ssh={data} onChanged={refresh} />
        ) : (
          <SshKeyMissing isError={isError} onChanged={refresh} />
        )}
      </SettingsSection>

      <SettingsSection icon={<Send className="h-4 w-4" />} title={t('set.sshDistribute')}>
        <DeployForm />
      </SettingsSection>
    </div>
  );
}

function SshKeyView({ ssh, onChanged }: { ssh: SSHKey; onChanged: () => void }) {
  const { t } = useTranslation();
  const escapedKey = ssh.publicKey.replace(/'/g, "'\\''");
  const installCmd = `mkdir -p ~/.ssh && echo '${escapedKey}' >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`;
  const [exportOpen, setExportOpen] = useState(false);
  const [importContent, setImportContent] = useState<string | null>(null);

  const copy = (text: string, msg: string) => {
    navigator.clipboard.writeText(text).then(() => showToast(msg, 'success'));
  };

  const onPickImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => setImportContent(String(e.target?.result || ''));
      reader.readAsText(file);
    };
    input.click();
  };

  return (
    <>
      <SettingsRow label={t('set.sshName')}>
        <span className="font-mono text-sm">{ssh.name || 'shipyard'}</span>
      </SettingsRow>
      <SettingsRow label={t('set.sshType')}>
        <span className="font-mono text-sm">ED25519</span>
      </SettingsRow>
      <SettingsRow label={t('set.sshStatus')}>
        {ssh.exists !== false ? (
          <Badge variant="success"><CheckCircle2 className="h-3 w-3" /> {t('set.sshActive')}</Badge>
        ) : (
          <Badge variant="muted"><XCircle className="h-3 w-3" /> {t('set.sshNotFound')}</Badge>
        )}
      </SettingsRow>

      <SettingsRow label={t('set.sshPublicKey')} align="start">
        <div className="relative w-full min-w-0 rounded-md border bg-muted/40 p-3 pr-24 font-mono text-xs leading-relaxed break-all">
          {ssh.publicKey}
          <Button
            variant="secondary" size="sm"
            className="absolute right-2 top-2"
            onClick={() => copy(ssh.publicKey, t('set.keyCopied'))}
          >
            <Copy className="h-3.5 w-3.5" /> {t('common.copy')}
          </Button>
        </div>
      </SettingsRow>

      <SettingsRow label={t('set.sshManualAdd')} hint={t('set.sshManualHint')} align="start">
        <div className="relative w-full min-w-0 rounded-md border bg-muted/40 p-3 pr-24 font-mono text-xs leading-relaxed break-all">
          {installCmd}
          <Button
            variant="secondary" size="sm"
            className="absolute right-2 top-2"
            onClick={() => copy(installCmd, t('set.cmdCopied'))}
          >
            <Copy className="h-3.5 w-3.5" /> {t('common.copy')}
          </Button>
        </div>
      </SettingsRow>

      <SettingsRow label={t('set.manageKey')} hint={t('set.manageKeyHint')} noBorder>
        <Button variant="secondary" size="sm" onClick={() => setExportOpen(true)}>
          <Download className="h-4 w-4" /> Export Key
        </Button>
        <Button variant="secondary" size="sm" onClick={onPickImport}>
          <Upload className="h-4 w-4" /> Import Key
        </Button>
      </SettingsRow>

      <ExportKeyDialog open={exportOpen} onOpenChange={setExportOpen} />
      <ImportKeyDialog
        content={importContent}
        onClose={() => setImportContent(null)}
        onImported={() => { setImportContent(null); onChanged(); }}
      />
    </>
  );
}

function SshKeyMissing({ isError, onChanged }: { isError?: boolean; onChanged: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [importContent, setImportContent] = useState<string | null>(null);

  const generate = async () => {
    setBusy(true);
    try {
      await api.generateSSHKey('shipyard');
      showToast(t('set.sshGenerated'), 'success');
      onChanged();
    } catch (err) {
      showToast(t('common.errorPrefix', { msg: (err as Error).message }), 'error');
    } finally { setBusy(false); }
  };

  const onPickImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => setImportContent(String(e.target?.result || ''));
      reader.readAsText(file);
    };
    input.click();
  };

  return (
    <>
      <SettingsRow label={t('set.sshStatus')} noBorder>
        <span className="text-sm text-muted-foreground">
          {isError ? t('common.error') : t('set.sshNone')}
        </span>
        <Button size="sm" onClick={generate} disabled={busy}>
          <Key className="h-4 w-4" /> {t('set.sshGenerate')}
        </Button>
        <Button variant="secondary" size="sm" onClick={onPickImport}>
          <Upload className="h-4 w-4" /> Import Key
        </Button>
      </SettingsRow>
      <ImportKeyDialog
        content={importContent}
        onClose={() => setImportContent(null)}
        onImported={() => { setImportContent(null); onChanged(); }}
      />
    </>
  );
}

function ExportKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useTranslation();
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (pass !== pass2) { showToast(t('set.exportKeyMismatch'), 'error'); return; }
    setBusy(true);
    try {
      const res = await api.exportSSHKey(pass) as { privateKey: string };
      const blob = new Blob([res.privateKey], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'shipyard_id_ed25519';
      a.click();
      URL.revokeObjectURL(a.href);
      onOpenChange(false);
      setPass(''); setPass2('');
    } catch (err) {
      showToast(t('common.errorPrefix', { msg: (err as Error).message }), 'error');
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>{t('set.exportKeyTitle')}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">{t('set.exportKeyHint')}</p>
        <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={t('set.exportKeyPlaceholder')} autoComplete="new-password" />
        <Input type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} placeholder={t('set.exportKeyConfirm')} autoComplete="new-password"
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={submit} disabled={busy}><Download className="h-4 w-4" /> {t('set.exportKeyBtn')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportKeyDialog({ content, onClose, onImported }: {
  content: string | null;
  onClose: () => void;
  onImported: () => void;
}) {
  const { t } = useTranslation();
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!content) return;
    setBusy(true);
    try {
      await api.importSSHKey(content, pass || '');
      showToast(t('set.importKeySuccess'), 'success');
      setPass('');
      onImported();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={content !== null} onOpenChange={(v) => { if (!v) { setPass(''); onClose(); } }}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>{t('set.importKeyTitle')}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">{t('set.importKeyHint')}</p>
        <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={t('set.importKeyPlaceholder')} autoComplete="current-password"
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={submit} disabled={busy}><Upload className="h-4 w-4" /> {t('set.importKeyBtn')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeployForm() {
  const { t } = useTranslation();
  const [ip, setIp]       = useState('');
  const [user, setUser]   = useState('root');
  const [port, setPort]   = useState('22');
  const [pw, setPw]       = useState('');
  const [busyOne, setBusyOne]   = useState(false);
  const [busyAll, setBusyAll]   = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);

  const deployOne = async () => {
    setBusyOne(true);
    try {
      await api.deploySSHKey({
        ip_address: ip,
        ssh_user: user || 'root',
        ssh_port: parseInt(port, 10) || 22,
        password: pw,
      });
      showToast(t('set.sshDistributed'), 'success');
      setPw('');
    } catch (err) {
      showToast(t('common.errorPrefix', { msg: (err as Error).message }), 'error');
    } finally { setBusyOne(false); }
  };

  const deployAll = async () => {
    setBusyAll(true);
    try {
      const result = (await api.deploySSHKeyAll({ password: pw })) as { succeeded: number; failed: number };
      showToast(
        t('set.sshDistributedAllResult', { succeeded: result.succeeded, failed: result.failed }),
        result.failed ? 'warning' : 'success'
      );
      setPw('');
    } catch (err) {
      showToast(t('common.errorPrefix', { msg: (err as Error).message }), 'error');
    } finally { setBusyAll(false); setConfirmAll(false); }
  };

  return (
    <>
      <SettingsRow label={t('set.sshTarget')} hint={t('set.sshTargetHint')}>
        <div className="grid w-full max-w-md grid-cols-[1fr_90px_70px] gap-2">
          <Input value={ip}   onChange={(e) => setIp(e.target.value)}   placeholder="192.168.1.100" />
          <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="root" />
          <Input value={port} onChange={(e) => setPort(e.target.value)} type="number" placeholder="22" />
        </div>
      </SettingsRow>

      <SettingsRow label={t('set.sshPassword')} hint={t('set.sshPasswordHint')}>
        <Input
          value={pw}
          type="password"
          onChange={(e) => setPw(e.target.value)}
          placeholder={t('set.serverPasswordPlaceholder')}
          autoComplete="new-password"
          className="max-w-md"
        />
      </SettingsRow>

      <SettingsRow label={null} hint={t('set.sshDistributeAllHint')} noBorder>
        <Button size="sm" onClick={deployOne} disabled={busyOne || !ip}>
          <Key className="h-4 w-4" /> {busyOne ? t('set.deploying') : t('set.sshDistributeBtn')}
        </Button>
        <Button
          variant="secondary" size="sm"
          onClick={() => {
            if (!pw) { showToast(t('set.serverPasswordPlaceholder'), 'error'); return; }
            setConfirmAll(true);
          }}
          disabled={busyAll}
        >
          <Key className="h-4 w-4" /> {busyAll ? t('set.deploying') : t('set.sshDistributeAllBtn')}
        </Button>
      </SettingsRow>

      <Dialog open={confirmAll} onOpenChange={setConfirmAll}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t('set.sshDistributeAllBtn')}</DialogTitle></DialogHeader>
          <p className="text-sm">{t('set.sshDeployAllConfirm')}</p>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmAll(false)}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={deployAll} disabled={busyAll}>{t('set.sshDistributeAllBtn')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

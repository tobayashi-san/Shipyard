import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Plus } from 'lucide-react';

export function CreateServerDialog() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [ip, setIp] = React.useState('');
  const [sshUser, setSshUser] = React.useState('root');
  const [sshPort, setSshPort] = React.useState('22');
  const [tags, setTags] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const reset = () => {
    setName(''); setIp(''); setSshUser('root'); setSshPort('22'); setTags(''); setError(null);
  };

  const mutation = useMutation({
    mutationFn: () => api.createServer({
      name: name.trim(),
      ip_address: ip.trim(),
      ssh_user: sshUser.trim() || 'root',
      ssh_port: Number.parseInt(sshPort, 10) || 22,
      tags: tags.split(',').map((s) => s.trim()).filter(Boolean),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['servers'] });
      reset();
      setOpen(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4" />
          {t('servers.addServer')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('servers.addServer')}</DialogTitle>
          <DialogDescription>{t('login.hint')}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (!name.trim() || !ip.trim()) {
              setError(t('common.error'));
              return;
            }
            mutation.mutate();
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label htmlFor="srv-name">{t('common.name')}</Label>
            <Input id="srv-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="srv-ip">{t('servers.host')}</Label>
              <Input id="srv-ip" placeholder="10.0.0.10" value={ip} onChange={(e) => setIp(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="srv-port">{t('servers.port')}</Label>
              <Input id="srv-port" type="number" min={1} max={65535} value={sshPort} onChange={(e) => setSshPort(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="srv-user">{t('servers.user')}</Label>
            <Input id="srv-user" value={sshUser} onChange={(e) => setSshUser(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="srv-tags">{t('servers.tags')}</Label>
            <Input id="srv-tags" placeholder="prod, web" value={tags} onChange={(e) => setTags(e.target.value)} />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={mutation.isPending}>{t('common.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

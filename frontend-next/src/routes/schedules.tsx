import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, PlayCircle, Calendar } from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';

interface Schedule {
  id: number | string;
  name?: string;
  playbook?: string;
  targets?: string;
  cron_expression?: string;
  enabled?: boolean | 0 | 1;
  next_run?: string;
  last_run?: string;
}

interface Playbook {
  filename: string;
  description?: string;
  isInternal?: boolean;
}

const CRON_PRESETS: Array<{ key: string; expr: string }> = [
  { key: 'sc.everyHour',    expr: '0 * * * *' },
  { key: 'sc.every6h',      expr: '0 */6 * * *' },
  { key: 'sc.daily3am',     expr: '0 3 * * *' },
  { key: 'sc.weeklyMonday', expr: '0 3 * * 1' },
  { key: 'sc.monthly',      expr: '0 3 1 * *' },
];

export function SchedulesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  const { data: schedules, isLoading } = useQuery<Schedule[]>({
    queryKey: ['schedules'],
    queryFn: async () => (await api.getSchedules()) as unknown as Schedule[],
  });

  const toggle = useMutation({
    mutationFn: (id: number | string) => api.toggleSchedule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
  });

  const del = useMutation({
    mutationFn: (id: number | string) => api.deleteSchedule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t('nav.schedules')}</h1>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="h-4 w-4" /> {t('sc.new')}</Button>
          </DialogTrigger>
          <CreateScheduleDialog
            onCreated={() => {
              setCreateOpen(false);
              qc.invalidateQueries({ queryKey: ['schedules'] });
            }}
          />
        </Dialog>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 text-sm text-muted-foreground">{t('common.loading')}</div>
          ) : !schedules || schedules.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
              <Calendar className="h-8 w-8" />
              <span className="text-sm">{t('sc.empty')}</span>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/30 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">{t('common.name')}</th>
                  <th className="px-4 py-2">{t('sc.playbook')}</th>
                  <th className="px-4 py-2">{t('sc.target')}</th>
                  <th className="px-4 py-2">{t('sc.cron')}</th>
                  <th className="px-4 py-2">{t('common.status')}</th>
                  <th className="px-4 py-2 text-right">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {schedules.map((s) => {
                  const enabled = !!s.enabled;
                  return (
                    <tr key={s.id} className="hover:bg-accent/30">
                      <td className="px-4 py-3 font-medium">{s.name || '—'}</td>
                      <td className="px-4 py-3 text-muted-foreground">{s.playbook}</td>
                      <td className="px-4 py-3 text-muted-foreground">{s.targets || 'all'}</td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{s.cron_expression}</td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => toggle.mutate(s.id)}
                          className={`inline-flex h-5 w-9 items-center rounded-full transition ${enabled ? 'bg-emerald-500' : 'bg-muted-foreground/30'}`}
                        >
                          <span className={`h-4 w-4 rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                        </button>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button variant="ghost" size="icon" onClick={() => del.mutate(s.id)} disabled={del.isPending}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CreateScheduleDialog({ onCreated }: { onCreated: () => void }) {
  const { t } = useTranslation();
  const { data: playbooks } = useQuery<Playbook[]>({
    queryKey: ['playbooks'],
    queryFn: async () => (await api.getPlaybooks()) as unknown as Playbook[],
  });
  const [name, setName] = useState('');
  const [playbook, setPlaybook] = useState('');
  const [targets, setTargets] = useState('all');
  const [cron, setCron] = useState('0 3 * * *');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const userPlaybooks = (playbooks ?? []).filter((p) => !p.isInternal);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError(t('sc.nameRequired')); return; }
    if (!playbook) { setError(t('sc.playbookRequired')); return; }
    setBusy(true);
    setError(null);
    try {
      await api.createSchedule({
        name: name.trim(),
        playbook,
        targets: targets.trim() || 'all',
        cronExpression: cron.trim(),
      });
      onCreated();
    } catch (err) {
      setError((err as Error).message || t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    if (!playbook) return;
    try {
      await api.runPlaybook(playbook, targets.trim() || 'all', {});
    } catch { /* user feedback handled elsewhere */ }
  };

  return (
    <DialogContent>
      <form onSubmit={submit}>
        <DialogHeader>
          <DialogTitle>{t('sc.new')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="sc-name">{t('common.name')}</Label>
            <Input id="sc-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sc-pb">{t('sc.playbook')}</Label>
            <select
              id="sc-pb"
              value={playbook}
              onChange={(e) => setPlaybook(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">{t('sc.selectPlaybook')}</option>
              {userPlaybooks.map((p) => (
                <option key={p.filename} value={p.filename}>{p.description || p.filename}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sc-tgt">{t('sc.target')}</Label>
            <Input id="sc-tgt" value={targets} onChange={(e) => setTargets(e.target.value)} placeholder="all" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sc-cron">{t('sc.cron')}</Label>
            <Input id="sc-cron" value={cron} onChange={(e) => setCron(e.target.value)} className="font-mono" />
            <div className="flex flex-wrap gap-1.5 pt-1">
              {CRON_PRESETS.map((p) => (
                <button
                  key={p.expr}
                  type="button"
                  onClick={() => setCron(p.expr)}
                  className={`rounded-md border px-2 py-0.5 text-xs transition ${cron === p.expr ? 'border-primary bg-primary/10' : 'border-input hover:bg-accent'}`}
                >
                  {t(p.key as 'sc.daily3am')}
                </button>
              ))}
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          {playbook && (
            <Button type="button" variant="outline" onClick={runNow}>
              <PlayCircle className="h-4 w-4" /> {t('sc.runNow')}
            </Button>
          )}
          <Button type="submit" disabled={busy}>{t('common.create')}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { QueryErrorState } from '@/components/ui/query-error-state';
import { useProfile, useSettings } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AppearanceTab } from './settings/tabs/appearance';
import { BackupTab } from './settings/tabs/backup';
import { DangerTab } from './settings/tabs/danger';
import { GitTab } from './settings/tabs/git';
import { NotificationsTab } from './settings/tabs/notifications';
import { SshTab } from './settings/tabs/ssh';
import { CollectionTab, SystemTab } from './settings/tabs/system';
import { UsersRolesTab } from './settings/tabs/users-roles';

const GROUPS = [
  { id: 'general', label: 'General' },
  { id: 'access', label: 'Access' },
  { id: 'connections', label: 'Connections' },
  { id: 'advanced', label: 'Advanced' },
];
const legacyGroup: Record<string, string> = { system: 'general', appearance: 'general', ssh: 'access', 'users-roles': 'access', git: 'connections', notifications: 'connections', collection: 'advanced', backup: 'advanced', danger: 'advanced' };
function SettingsDisclosure({ title, children, open = false }: { title: string; children: React.ReactNode; open?: boolean }) {
  const [expanded, setExpanded] = useState(open);
  const [mounted, setMounted] = useState(open);
  return <details open={expanded} onToggle={event => { setExpanded(event.currentTarget.open); if (event.currentTarget.open) setMounted(true); }} className="rounded-md border p-4"><summary className="cursor-pointer font-medium">{title}</summary>{mounted && <div className="mt-4">{children}</div>}</details>;
}

export function SettingsPage() {
  const { t } = useTranslation();
  const profileQuery = useProfile();
  const profile = profileQuery.data;

  if (profileQuery.isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('set.title')} />
      </div>
    );
  }

  if (profileQuery.isError) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('set.title')} />
        <QueryErrorState
          error={profileQuery.error}
          title="Administration access could not be verified"
          onRetry={() => void profileQuery.refetch()}
        />
      </div>
    );
  }

  if (profile?.role !== 'admin') {
    return (
      <div className="space-y-6">
        <PageHeader title={t('set.title')} />
        <EmptyState
          icon={<Lock className="h-5 w-5" />}
          title={t('set.adminOnlyTitle')}
          description={t('set.adminOnlyDescription')}
        />
      </div>
    );
  }

  return <AdminSettingsPage />;
}

function AdminSettingsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { tab?: string };
  const settingsQuery = useSettings();
  const activeId = legacyGroup[params.tab || ''] || GROUPS.find(group => group.id === params.tab)?.id || 'general';

  useEffect(() => {
    if (params.tab === 'audit') void navigate({ to: '/operations', search: {section:'audit'}, replace: true });
  }, [navigate, params.tab]);

  if (settingsQuery.isError) {
    return (
      <div className="space-y-5">
        <PageHeader title={t('set.title')} />
        <QueryErrorState
          error={settingsQuery.error}
          title="Administration settings could not be loaded"
          onRetry={() => void settingsQuery.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader title={t('set.title')} />

      <nav className="flex flex-wrap gap-1 border-b pb-2" aria-label="Settings">
        {GROUPS.map(group => <Link key={group.id} to="/settings/$tab" params={{tab: group.id}} aria-current={activeId === group.id ? 'page' : undefined} className={cn('rounded-sm px-4 py-2 text-sm', activeId === group.id ? 'bg-accent font-semibold' : 'text-muted-foreground hover:bg-accent')}>{group.label}</Link>)}
      </nav>
      <div key={params.tab || 'general'} className="space-y-4">
        {activeId === 'general' && <>
          <SystemTab />
          <SettingsDisclosure title="Branding" open={params.tab === 'appearance'}><AppearanceTab /></SettingsDisclosure>
        </>}
        {activeId === 'access' && <>
          <UsersRolesTab />
          <SettingsDisclosure title="SSH credentials" open={params.tab === 'ssh'}><SshTab /></SettingsDisclosure>
        </>}
        {activeId === 'connections' && <>
          <Button asChild variant="outline"><Link to="/infrastructure" search={{section: 'platforms'}}>Manage connections</Link></Button>
          <SettingsDisclosure title="Playbook Git" open={params.tab === 'git'}><GitTab /></SettingsDisclosure>
          <SettingsDisclosure title="Notifications" open={params.tab === 'notifications'}><NotificationsTab /></SettingsDisclosure>
        </>}
        {activeId === 'advanced' && <>
          <SettingsDisclosure title="Adaptive collection" open={params.tab === 'collection'}><CollectionTab /></SettingsDisclosure>
          <SettingsDisclosure title="Application export and restore" open={params.tab === 'backup'}><BackupTab /></SettingsDisclosure>
          <SettingsDisclosure title="Reset application" open={params.tab === 'danger'}><DangerTab /></SettingsDisclosure>
        </>}
      </div>
    </div>
  );
}

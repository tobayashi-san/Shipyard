import { useTranslation } from 'react-i18next';
import { Link, useParams } from '@tanstack/react-router';
import { Lock } from 'lucide-react';
import { useProfile, useSettings } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';

import { AppearanceTab } from './settings/tabs/appearance';
import { SshTab } from './settings/tabs/ssh';
import { SystemTab } from './settings/tabs/system';
import { AgentManifestTab } from './settings/tabs/agent-manifest';
import { NotificationsTab } from './settings/tabs/notifications';
import { GitTab } from './settings/tabs/git';
import { PluginsTab } from './settings/tabs/plugins';
import { UsersRolesTab } from './settings/tabs/users-roles';
import { AuditTab } from './settings/tabs/audit';
import { DangerTab } from './settings/tabs/danger';

interface TabDef {
  id: string;
  i18nKey: string;
  Component: React.ComponentType;
  /** Console grouping keeps a growing administration surface scannable. */
  section: 'Console' | 'Access & security' | 'Integrations' | 'Operations & system';
  /** Render only when whitelabel.agentEnabled is true (matches legacy behaviour). */
  agentOnly?: boolean;
}

const TABS: TabDef[] = [
  { id: 'appearance',     i18nKey: 'set.tabAppearance',    Component: AppearanceTab, section: 'Console' },
  { id: 'system',         i18nKey: 'set.tabSystem',        Component: SystemTab, section: 'Operations & system' },
  { id: 'ssh',            i18nKey: 'set.tabSsh',           Component: SshTab, section: 'Access & security' },
  { id: 'agent-manifest', i18nKey: 'set.tabAgentManifest', Component: AgentManifestTab, section: 'Access & security', agentOnly: true },
  { id: 'users-roles',    i18nKey: 'set.userManagement',   Component: UsersRolesTab, section: 'Access & security' },
  { id: 'git',            i18nKey: 'git.title',            Component: GitTab, section: 'Integrations' },
  { id: 'plugins',        i18nKey: 'set.tabPlugins',       Component: PluginsTab, section: 'Integrations' },
  { id: 'notifications',  i18nKey: 'set.notifications',    Component: NotificationsTab, section: 'Integrations' },
  { id: 'audit',          i18nKey: 'set.tabAudit',         Component: AuditTab, section: 'Operations & system' },
  { id: 'danger',         i18nKey: 'set.danger',           Component: DangerTab, section: 'Operations & system' },
];

export function SettingsPage() {
  const { t } = useTranslation();
  const { data: profile, isLoading } = useProfile();

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('set.title')} description={t('set.subtitle')} />
      </div>
    );
  }

  if (profile?.role !== 'admin') {
    return (
      <div className="space-y-6">
        <PageHeader title={t('set.title')} description={t('set.subtitle')} />
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
  const params = useParams({ strict: false }) as { tab?: string };
  const { data: settings } = useSettings();

  const agentEnabled = Boolean(
    (settings as Record<string, unknown> | undefined)?.agentEnabled
  );

  const visibleTabs = TABS.filter((tab) => !tab.agentOnly || agentEnabled);
  const activeId = visibleTabs.find((tab) => tab.id === params.tab)?.id ?? visibleTabs[0]?.id;
  const ActiveComponent = visibleTabs.find((tab) => tab.id === activeId)?.Component;
  const sections = ['Console', 'Access & security', 'Integrations', 'Operations & system'] as const;

  return (
    <div className="space-y-5">
      <PageHeader title={t('set.title')} description={t('set.subtitle')} />

      <div className="flex flex-col gap-5 lg:flex-row">
        <nav className="shrink-0 lg:w-60 lg:rounded-[3px] lg:border lg:border-border-strong/80 lg:bg-card lg:p-2 lg:shadow-[0_1px_2px_hsl(var(--foreground)/0.035)]" aria-label="Settings">
          <div className="hidden px-2 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground lg:block">Administration</div>
          <div className="-mx-3 flex flex-row gap-1 overflow-x-auto px-3 pb-1 sm:-mx-4 sm:px-4 lg:mx-0 lg:flex-col lg:gap-3 lg:px-0 lg:overflow-visible">
            {sections.map(section => {
              const tabs = visibleTabs.filter(tab => tab.section === section);
              if (!tabs.length) return null;
              return <div key={section} className="flex shrink-0 gap-1 lg:block">
                <div className="hidden px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground lg:block">{section}</div>
                <ul className="flex gap-1 lg:block lg:space-y-0.5">
                  {tabs.map(tab => {
                    const isActive = tab.id === activeId;
                    return <li key={tab.id}><Link to="/settings/$tab" params={{ tab: tab.id }} className={cn(
                      'relative block whitespace-nowrap rounded-sm px-2.5 py-1.5 text-[13px] transition-colors',
                      isActive ? 'bg-primary/[0.09] font-semibold text-foreground before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:bg-primary' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                    )}>{t(tab.i18nKey)}</Link></li>;
                  })}
                </ul>
              </div>;
            })}
          </div>
        </nav>

        <div className="min-w-0 flex-1">
          {ActiveComponent ? <ActiveComponent /> : null}
        </div>
      </div>
    </div>
  );
}

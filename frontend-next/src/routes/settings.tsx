import { useTranslation } from 'react-i18next';
import { Link, useParams } from '@tanstack/react-router';
import { useSettings } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/ui/page-header';

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
  /** Render only when whitelabel.agentEnabled is true (matches legacy behaviour). */
  agentOnly?: boolean;
}

const TABS: TabDef[] = [
  { id: 'appearance',     i18nKey: 'set.tabAppearance',    Component: AppearanceTab },
  { id: 'ssh',            i18nKey: 'set.tabSsh',           Component: SshTab },
  { id: 'system',         i18nKey: 'set.tabSystem',        Component: SystemTab },
  { id: 'agent-manifest', i18nKey: 'set.tabAgentManifest', Component: AgentManifestTab, agentOnly: true },
  { id: 'notifications',  i18nKey: 'set.notifications',    Component: NotificationsTab },
  { id: 'git',            i18nKey: 'git.title',            Component: GitTab },
  { id: 'plugins',        i18nKey: 'set.tabPlugins',       Component: PluginsTab },
  { id: 'users-roles',    i18nKey: 'set.userManagement',   Component: UsersRolesTab },
  { id: 'audit',          i18nKey: 'set.tabAudit',         Component: AuditTab },
  { id: 'danger',         i18nKey: 'set.danger',           Component: DangerTab },
];

export function SettingsPage() {
  const { t } = useTranslation();
  const params = useParams({ strict: false }) as { tab?: string };
  const { data: settings } = useSettings();

  const agentEnabled = Boolean(
    (settings as Record<string, unknown> | undefined)?.agentEnabled
  );

  const visibleTabs = TABS.filter((tab) => !tab.agentOnly || agentEnabled);
  const activeId = visibleTabs.find((tab) => tab.id === params.tab)?.id ?? visibleTabs[0]?.id;
  const ActiveComponent = visibleTabs.find((tab) => tab.id === activeId)?.Component;

  return (
    <div className="space-y-4">
      <PageHeader title={t('set.title')} description={t('set.subtitle')} />

      <div className="flex flex-col gap-4 lg:flex-row">
        <nav className="lg:w-56 shrink-0">
          <ul className="flex flex-row gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
            {visibleTabs.map((tab) => {
              const isActive = tab.id === activeId;
              return (
                <li key={tab.id}>
                  <Link
                    to="/settings/$tab"
                    params={{ tab: tab.id }}
                    className={cn(
                      'block whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors',
                      isActive
                        ? 'bg-accent text-accent-foreground font-medium'
                        : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                    )}
                  >
                    {t(tab.i18nKey)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="min-w-0 flex-1">
          {ActiveComponent ? <ActiveComponent /> : null}
        </div>
      </div>
    </div>
  );
}

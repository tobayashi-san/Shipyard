import { createRootRoute, createRoute, createRouter, Outlet, redirect } from '@tanstack/react-router';
import { AppShell } from '@/components/layout/AppShell';
import { LoginPage } from '@/routes/login';
import { OnboardingPage } from '@/routes/onboarding';
import { DashboardPage } from '@/routes/dashboard';
import { ServersPage } from '@/routes/servers';
import { ServerDetailPage } from '@/routes/server-detail';
import { PlaybooksPage } from '@/routes/playbooks';
import { SchedulesPage } from '@/routes/schedules';
import { SettingsPage } from '@/routes/settings';
import { AuditPage } from '@/routes/audit';
import { AgentPage } from '@/routes/agent';
import { PluginsPage, PluginHostPage } from '@/routes/plugins';
import { getToken } from '@/lib/auth';

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/onboarding',
  component: OnboardingPage,
});

// Authenticated layout: redirects to /login if no token.
const protectedLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: '_protected',
  beforeLoad: () => {
    if (!getToken()) {
      throw redirect({ to: '/login' });
    }
  },
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});

const dashboardRoute = createRoute({ getParentRoute: () => protectedLayout, path: '/',           component: DashboardPage });
const serversRoute   = createRoute({ getParentRoute: () => protectedLayout, path: '/servers',    component: ServersPage });
const serverDetail   = createRoute({ getParentRoute: () => protectedLayout, path: '/servers/$id', component: ServerDetailPage });
const playbooksRoute = createRoute({ getParentRoute: () => protectedLayout, path: '/playbooks',  component: PlaybooksPage });
const schedulesRoute = createRoute({ getParentRoute: () => protectedLayout, path: '/schedules',  component: SchedulesPage });
const settingsRoute  = createRoute({ getParentRoute: () => protectedLayout, path: '/settings',   component: SettingsPage });
const auditRoute     = createRoute({ getParentRoute: () => protectedLayout, path: '/audit',      component: AuditPage });
const agentRoute     = createRoute({ getParentRoute: () => protectedLayout, path: '/agent',      component: AgentPage });
const pluginsRoute   = createRoute({ getParentRoute: () => protectedLayout, path: '/plugins',    component: PluginsPage });
const pluginHostRoute = createRoute({ getParentRoute: () => protectedLayout, path: '/plugins/$id', component: PluginHostPage });

const routeTree = rootRoute.addChildren([
  loginRoute,
  onboardingRoute,
  protectedLayout.addChildren([
    dashboardRoute,
    serversRoute,
    serverDetail,
    playbooksRoute,
    schedulesRoute,
    settingsRoute,
    auditRoute,
    agentRoute,
    pluginsRoute,
    pluginHostRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  basepath: '/next',
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}

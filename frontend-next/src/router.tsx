import { createRootRoute, createRoute, createRouter, Outlet, redirect } from '@tanstack/react-router';
import { AppShell } from '@/components/layout/AppShell';
import { LoginPage } from '@/routes/login';
import { OnboardingPage } from '@/routes/onboarding';
import { DashboardPage } from '@/routes/dashboard';
import { ServersPage } from '@/routes/servers';
import { ServerDetailPage } from '@/routes/server-detail';
import { PlaybooksPage } from '@/routes/playbooks';
import { SettingsPage } from '@/routes/settings';
import { ProfilePage } from '@/routes/profile';
import { PluginHostPage } from '@/routes/_legacy/plugins';
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

const dashboardRoute  = createRoute({ getParentRoute: () => protectedLayout, path: '/',             component: DashboardPage });
const serversRoute    = createRoute({ getParentRoute: () => protectedLayout, path: '/servers',      component: ServersPage });
const serverDetail    = createRoute({ getParentRoute: () => protectedLayout, path: '/servers/$id',  component: ServerDetailPage });
const playbooksRoute  = createRoute({ getParentRoute: () => protectedLayout, path: '/playbooks',    component: PlaybooksPage });
const profileRoute    = createRoute({ getParentRoute: () => protectedLayout, path: '/profile',      component: ProfilePage });
// Settings is the single page that hosts: appearance, ssh, system, agent-manifest,
// notifications, git, plugins, users-roles, audit, danger — matching the legacy UI.
// Tab is selected via the optional :tab path segment (default = appearance).
const settingsRoute   = createRoute({ getParentRoute: () => protectedLayout, path: '/settings',     component: SettingsPage });
const settingsTabRoute= createRoute({ getParentRoute: () => protectedLayout, path: '/settings/$tab', component: SettingsPage });
// Plugin host route: dynamically loaded plugin UIs (sidebar entries link here).
const pluginHostRoute = createRoute({ getParentRoute: () => protectedLayout, path: '/plugins/$id',  component: PluginHostPage });

const routeTree = rootRoute.addChildren([
  loginRoute,
  onboardingRoute,
  protectedLayout.addChildren([
    dashboardRoute,
    serversRoute,
    serverDetail,
    playbooksRoute,
    profileRoute,
    settingsRoute,
    settingsTabRoute,
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

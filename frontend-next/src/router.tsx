import { createRootRoute, createRoute, createRouter, Outlet, redirect } from '@tanstack/react-router';
import { lazy, Suspense, type ReactNode } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { LoginPage } from '@/routes/login';
import { OnboardingPage } from '@/routes/onboarding';
import { DashboardPage } from '@/routes/dashboard';
import { getToken } from '@/lib/auth';

const PlaybooksPage = lazy(() => import('@/routes/playbooks').then(module => ({ default: module.PlaybooksPage })));
const ServersPage = lazy(() => import('@/routes/servers').then(module => ({ default: module.ServersPage })));
const ServerDetailPage = lazy(() => import('@/routes/server-detail').then(module => ({ default: module.ServerDetailPage })));
const SettingsPage = lazy(() => import('@/routes/settings').then(module => ({ default: module.SettingsPage })));
const ProfilePage = lazy(() => import('@/routes/profile').then(module => ({ default: module.ProfilePage })));
const DeploymentsPage = lazy(() => import('@/routes/deployments').then(module => ({ default: module.DeploymentsPage })));
const DeploymentDetailPage = lazy(() => import('@/routes/deployment-detail').then(module => ({ default: module.DeploymentDetailPage })));
const InfrastructurePage = lazy(() => import('@/routes/infrastructure').then(module => ({ default: module.InfrastructurePage })));
const OperationsPage = lazy(() => import('@/routes/operations').then(module => ({ default: module.OperationsPage })));
const NetworksPage = lazy(() => import('@/routes/networks').then(module => ({ default: module.NetworksPage })));
const NetworkDetailPage = lazy(() => import('@/routes/network-detail').then(module => ({ default: module.NetworkDetailPage })));
const PluginHostPage = lazy(() => import('@/routes/_legacy/plugins').then(module => ({ default: module.PluginHostPage })));
const LazyPage = ({ children }: { children: ReactNode }) => <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Lade Konsole…</div>}>{children}</Suspense>;

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
const serversRoute    = createRoute({ getParentRoute: () => protectedLayout, path: '/servers',      component: () => <LazyPage><ServersPage /></LazyPage> });
const serverDetail    = createRoute({ getParentRoute: () => protectedLayout, path: '/servers/$id',  component: () => <LazyPage><ServerDetailPage /></LazyPage> });
const playbooksRoute  = createRoute({ getParentRoute: () => protectedLayout, path: '/playbooks',    component: () => <LazyPage><PlaybooksPage /></LazyPage> });
const profileRoute    = createRoute({ getParentRoute: () => protectedLayout, path: '/profile',      component: () => <LazyPage><ProfilePage /></LazyPage> });
const deploymentsRoute= createRoute({ getParentRoute: () => protectedLayout, path: '/deployments',  component: () => <LazyPage><DeploymentsPage /></LazyPage> });
const deploymentDetailRoute = createRoute({ getParentRoute: () => protectedLayout, path: '/deployments/$id', component: () => <LazyPage><DeploymentDetailPage /></LazyPage> });
const infrastructureRoute = createRoute({ getParentRoute: () => protectedLayout, path: '/infrastructure', component: () => <LazyPage><InfrastructurePage /></LazyPage> });
const operationsRoute = createRoute({ getParentRoute: () => protectedLayout, path: '/operations', component: () => <LazyPage><OperationsPage /></LazyPage> });
const networksRoute = createRoute({ getParentRoute: () => protectedLayout, path: '/networks', component: () => <LazyPage><NetworksPage /></LazyPage> });
const networkDetailRoute = createRoute({ getParentRoute: () => protectedLayout, path: '/networks/$id', component: () => <LazyPage><NetworkDetailPage /></LazyPage> });
// Settings is the single page that hosts: appearance, ssh, system, agent-manifest,
// notifications, git, plugins, users-roles, audit, danger.
// Tab is selected via the optional :tab path segment (default = appearance).
const settingsRoute   = createRoute({ getParentRoute: () => protectedLayout, path: '/settings',     component: () => <LazyPage><SettingsPage /></LazyPage> });
const settingsTabRoute= createRoute({ getParentRoute: () => protectedLayout, path: '/settings/$tab', component: () => <LazyPage><SettingsPage /></LazyPage> });
// Plugin host route: dynamically loaded plugin UIs (sidebar entries link here).
const pluginHostRoute = createRoute({ getParentRoute: () => protectedLayout, path: '/plugins/$id',  component: () => <LazyPage><PluginHostPage /></LazyPage> });

const routeTree = rootRoute.addChildren([
  loginRoute,
  onboardingRoute,
  protectedLayout.addChildren([
    dashboardRoute,
    serversRoute,
    serverDetail,
    playbooksRoute,
    profileRoute,
    deploymentsRoute,
    deploymentDetailRoute,
    infrastructureRoute,
    operationsRoute,
    networksRoute,
    networkDetailRoute,
    settingsRoute,
    settingsTabRoute,
    pluginHostRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}

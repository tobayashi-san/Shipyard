import { createRootRoute, createRoute, createRouter, Navigate, Outlet, redirect } from '@tanstack/react-router';
import { lazy, Suspense, type ReactNode } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { LoginPage } from '@/routes/login';
import { OnboardingPage } from '@/routes/onboarding';
import { DashboardPage } from '@/routes/dashboard';
import { getToken } from '@/lib/auth';
import { api } from '@/lib/api';
import { canAccessDeployments, canAccessInfrastructure, canAccessNetworks, canAccessOperations, hasCap, useProfile, type Profile } from '@/lib/queries';

const PlaybooksPage = lazy(() => import('@/routes/playbooks').then(module => ({ default: module.PlaybooksPage })));
const ServersPage = lazy(() => import('@/routes/servers').then(module => ({ default: module.ServersPage })));
const ServerDetailPage = lazy(() => import('@/routes/server-detail').then(module => ({ default: module.ServerDetailPage })));
const SettingsPage = lazy(() => import('@/routes/settings').then(module => ({ default: module.SettingsPage })));
const ProfilePage = lazy(() => import('@/routes/profile').then(module => ({ default: module.ProfilePage })));
const DeploymentsPage = lazy(() => import('@/routes/deployments').then(module => ({ default: module.DeploymentsPage })));
const DeploymentDetailPage = lazy(() => import('@/routes/deployment-detail').then(module => ({ default: module.DeploymentDetailPage })));
const InfrastructureDetailPage = lazy(() => import('@/routes/infrastructure-detail').then(module => ({ default: module.InfrastructureDetailPage })));
const InfrastructurePage = lazy(() => import('@/routes/infrastructure').then(module => ({ default: module.InfrastructurePage })));
const ProxmoxVmDetailPage = lazy(() => import('@/routes/proxmox-vm-detail').then(module => ({ default: module.ProxmoxVmDetailPage })));
const OperationsPage = lazy(() => import('@/routes/operations').then(module => ({ default: module.OperationsPage })));
const NetworksPage = lazy(() => import('@/routes/networks').then(module => ({ default: module.NetworksPage })));
const IpamSourcesPage = lazy(() => import('@/routes/ipam-sources').then(module => ({ default: module.IpamSourcesPage })));
const NetworkDetailPage = lazy(() => import('@/routes/network-detail').then(module => ({ default: module.NetworkDetailPage })));
const PluginHostPage = lazy(() => import('@/routes/_legacy/plugins').then(module => ({ default: module.PluginHostPage })));
const LazyPage = ({ children }: { children: ReactNode }) => <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading console…</div>}>{children}</Suspense>;
const PermissionGate = ({ allow, children }: { allow: (profile: Profile) => boolean; children: ReactNode }) => {
  const { data: profile, isPending } = useProfile();
  if (isPending) return <div className="p-6 text-sm text-muted-foreground">Checking access…</div>;
  if (!profile || !allow(profile)) return <Navigate to="/" replace />;
  return children;
};

interface ServersSearch {
  status?: 'online' | 'offline' | 'unknown';
  attention?: boolean;
  updates?: boolean;
}

interface OperationsSearch {
  scope?: 'active' | 'failed';
  section?: 'tasks' | 'maintenance' | 'audit';
  source?: 'Host' | 'Deployment' | 'Workflow' | 'Audit';
  q?: string;
  from?: string;
  to?: string;
  page?: number;
}

interface InfrastructureSearch {
  section?: 'platforms' | 'nodes' | 'guests' | 'datastores';
}

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/onboarding',
  beforeLoad: async () => {
    const status = await api.authStatus();
    if (!status.configured) return;
    if (getToken()) {
      let sessionIsValid = false;
      try {
        await api.getProfile();
        sessionIsValid = true;
      } catch { /* expired or invalid token: continue to login */ }
      if (sessionIsValid) throw redirect({ to: '/' });
    }
    throw redirect({ to: '/login' });
  },
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
const serversRoute    = createRoute({
  getParentRoute: () => protectedLayout,
  path: '/servers',
  validateSearch: (search: Record<string, unknown>): ServersSearch => {
    const result: ServersSearch = {};
    if (search.status === 'online' || search.status === 'offline' || search.status === 'unknown') result.status = search.status;
    if (search.attention === true || search.attention === 'true') result.attention = true;
    if (search.updates === true || search.updates === 'true') result.updates = true;
    return result;
  },
  component: () => <PermissionGate allow={profile => hasCap(profile, 'canViewServers')}><LazyPage><ServersPage /></LazyPage></PermissionGate>,
});
const serverDetail    = createRoute({ getParentRoute: () => protectedLayout, path: '/servers/$id',  component: () => <PermissionGate allow={profile => hasCap(profile, 'canViewServers')}><LazyPage><ServerDetailPage /></LazyPage></PermissionGate> });
const playbooksRoute  = createRoute({ getParentRoute: () => protectedLayout, path: '/playbooks',    component: () => <PermissionGate allow={profile => hasCap(profile, 'canViewPlaybooks')}><LazyPage><PlaybooksPage /></LazyPage></PermissionGate> });
const profileRoute    = createRoute({ getParentRoute: () => protectedLayout, path: '/profile',      component: () => <LazyPage><ProfilePage /></LazyPage> });
const deploymentsRoute= createRoute({ getParentRoute: () => protectedLayout, path: '/deployments',  component: () => <PermissionGate allow={canAccessDeployments}><LazyPage><DeploymentsPage /></LazyPage></PermissionGate> });
const deploymentDetailRoute = createRoute({ getParentRoute: () => protectedLayout, path: '/deployments/$id', component: () => <PermissionGate allow={canAccessDeployments}><LazyPage><DeploymentDetailPage /></LazyPage></PermissionGate> });
const infrastructureRoute = createRoute({
  getParentRoute: () => protectedLayout,
  path: '/infrastructure',
  validateSearch: (search: Record<string, unknown>): InfrastructureSearch => {
    const result: InfrastructureSearch = {};
    if (search.section === 'platforms' || search.section === 'nodes' || search.section === 'guests' || search.section === 'datastores') result.section = search.section;
    return result;
  },
  component: () => <PermissionGate allow={canAccessInfrastructure}><LazyPage><InfrastructurePage /></LazyPage></PermissionGate>,
});
const infrastructureDetailRoute = createRoute({ getParentRoute: () => protectedLayout, path: '/infrastructure/$clusterId', component: () => <PermissionGate allow={canAccessInfrastructure}><LazyPage><InfrastructureDetailPage /></LazyPage></PermissionGate> });
const infrastructureNodeRoute = createRoute({ getParentRoute: () => protectedLayout, path: '/infrastructure/$clusterId/nodes/$nodeName', component: () => <PermissionGate allow={canAccessInfrastructure}><LazyPage><InfrastructureDetailPage /></LazyPage></PermissionGate> });
const infrastructureVmRoute = createRoute({ getParentRoute: () => protectedLayout, path: '/infrastructure/$clusterId/nodes/$nodeName/vms/$vmId', component: () => <PermissionGate allow={canAccessInfrastructure}><LazyPage><ProxmoxVmDetailPage /></LazyPage></PermissionGate> });
const operationsRoute = createRoute({
  getParentRoute: () => protectedLayout,
  path: '/operations',
  validateSearch: (search: Record<string, unknown>): OperationsSearch => {
    const result: OperationsSearch = {};
    if (search.scope === 'active' || search.scope === 'failed') result.scope = search.scope;
    if (search.section === 'tasks' || search.section === 'maintenance' || search.section === 'audit') result.section = search.section;
    if (search.source === 'Host' || search.source === 'Deployment' || search.source === 'Workflow' || search.source === 'Audit') result.source = search.source;
    if (typeof search.q === 'string' && search.q.trim()) result.q = search.q;
    if (typeof search.from === 'string') result.from = search.from;
    if (typeof search.to === 'string') result.to = search.to;
    const page = Number(search.page);
    if (Number.isInteger(page) && page > 1) result.page = page;
    return result;
  },
  component: () => <PermissionGate allow={canAccessOperations}><LazyPage><OperationsPage /></LazyPage></PermissionGate>,
});
const networksRoute = createRoute({ getParentRoute: () => protectedLayout, path: '/networks', component: () => <PermissionGate allow={canAccessNetworks}><LazyPage><NetworksPage /></LazyPage></PermissionGate> });
const ipamSourcesRoute = createRoute({ getParentRoute: () => protectedLayout, path: '/networks/sources', component: () => <PermissionGate allow={canAccessNetworks}><LazyPage><IpamSourcesPage /></LazyPage></PermissionGate> });
const networkDetailRoute = createRoute({ getParentRoute: () => protectedLayout, path: '/networks/$id', component: () => <PermissionGate allow={canAccessNetworks}><LazyPage><NetworkDetailPage /></LazyPage></PermissionGate> });
// Settings is the single page that hosts: appearance, ssh, system, agent-manifest,
// notifications, git, plugins, users-roles, audit, danger.
// Tab is selected via the optional :tab path segment (default = appearance).
const settingsRoute   = createRoute({ getParentRoute: () => protectedLayout, path: '/settings',     component: () => <PermissionGate allow={profile => profile.role === 'admin'}><LazyPage><SettingsPage /></LazyPage></PermissionGate> });
const settingsTabRoute= createRoute({ getParentRoute: () => protectedLayout, path: '/settings/$tab', component: () => <PermissionGate allow={profile => profile.role === 'admin'}><LazyPage><SettingsPage /></LazyPage></PermissionGate> });
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
    infrastructureDetailRoute,
    infrastructureNodeRoute,
    infrastructureVmRoute,
    operationsRoute,
    networksRoute,
    ipamSourcesRoute,
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

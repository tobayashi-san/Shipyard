import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface Permissions {
  full?: boolean;
  servers?: 'all' | { groups?: (string | number)[]; servers?: (string | number)[] };
  playbooks?: 'all' | string[];
  plugins?: 'all' | string[];
  // Capability flags (canViewServers, canRunPlaybooks, ...); backend sends explicit values.
  [cap: string]: unknown;
}

export interface Profile {
  id?: string | number;
  username?: string;
  displayName?: string;
  role?: 'admin' | 'user' | string;
  permissions?: Permissions;
  [k: string]: unknown;
}

export interface PluginInfo {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  enabled?: boolean;
  loaded?: boolean;
  error?: string;
  sidebar?: { icon?: string; label?: string };
  [k: string]: unknown;
}

/** Fetches the logged-in profile (cached for the session). */
export function useProfile() {
  return useQuery<Profile>({
    queryKey: ['profile'],
    queryFn: () => api.getProfile() as Promise<Profile>,
    staleTime: 5 * 60_000,
  });
}

/** Fetches the plugin list (used by sidebar + Settings → Plugins tab). */
export function usePlugins() {
  return useQuery<PluginInfo[]>({
    queryKey: ['plugins'],
    queryFn: () => api.getPlugins() as Promise<PluginInfo[]>,
    staleTime: 60_000,
  });
}

/** Settings (whitelabel + feature flags). */
export function useSettings() {
  return useQuery<Record<string, unknown>>({
    queryKey: ['settings'],
    queryFn: () => api.getSettings() as Promise<Record<string, unknown>>,
    staleTime: 60_000,
  });
}

/** Environments are global console context and shared by headers and dialogs. */
export function useEnvironments() {
  return useQuery<Array<Record<string, unknown>>>({
    queryKey: ['environments'],
    queryFn: () => api.getEnvironments() as Promise<Array<Record<string, unknown>>>,
    staleTime: 60_000,
  });
}

/**
 * Capability check matching backend permission semantics:
 *   - admin or `full=true` → always true
 *   - explicit cap === true → true
 *   - missing/false caps → false
 */
export function hasCap(profile: Profile | undefined | null, cap: string): boolean {
  if (!profile) return false;
  if (profile.role === 'admin') return true;
  const perms = profile.permissions;
  if (!perms) return false;
  if (perms.full) return true;
  return perms[cap] === true;
}

/** Whether the user can see a given plugin in the sidebar. */
export function canSeePlugin(profile: Profile | undefined | null, pluginId: string): boolean {
  if (!profile) return false;
  if (profile.role === 'admin') return true;
  const perms = profile.permissions;
  if (!perms) return false;
  if (perms.full || perms.plugins === 'all') return true;
  return Array.isArray(perms.plugins) && perms.plugins.includes(pluginId);
}

/** Shared navigation rule for the built-in deployment area. */
export function canAccessDeployments(profile: Profile | undefined | null): boolean {
  return hasCap(profile, 'canViewDeployments') || hasCap(profile, 'canManageDeployments');
}

/** Shared navigation rule for the operational workbench and maintenance windows. */
export function canAccessOperations(profile: Profile | undefined | null): boolean {
  return canAccessDeployments(profile)
    || hasCap(profile, 'canViewSchedules')
    || hasCap(profile, 'canViewAudit')
    || hasCap(profile, 'canViewMaintenance');
}

/** Proxmox/platform inventory is deliberately separate from hosts. */
export function canAccessInfrastructure(profile: Profile | undefined | null): boolean {
  return hasCap(profile, 'canViewInfrastructure') || hasCap(profile, 'canManageDeploymentPlatforms');
}

/** IPAM/network inventory has its own scope instead of inheriting host visibility. */
export function canAccessNetworks(profile: Profile | undefined | null): boolean {
  return hasCap(profile, 'canViewNetworks') || hasCap(profile, 'canEditNetworks');
}

/** Whether operational live events are useful and permitted for this session. */
export function canViewActivity(profile: Profile | undefined | null): boolean {
  return canAccessDeployments(profile)
    || hasCap(profile, 'canViewSchedules')
    || hasCap(profile, 'canViewPlaybooks')
    || hasCap(profile, 'canViewUpdates')
    || hasCap(profile, 'canViewDocker')
    || hasCap(profile, 'canViewCustomUpdates');
}

import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface Permissions {
  full?: boolean;
  servers?: 'all' | { groups?: (string | number)[]; servers?: (string | number)[] };
  playbooks?: 'all' | string[];
  plugins?: 'all' | string[];
  // Capability flags (canViewServers, canRunPlaybooks, …); unspecified => true for admin/built-in roles.
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

/**
 * Capability check matching legacy `hasCap` semantics:
 *   - admin or `full=true` → always true
 *   - permissions object with explicit cap === false → false
 *   - otherwise → true (fail-open for unknown caps; matches legacy behaviour)
 */
export function hasCap(profile: Profile | undefined | null, cap: string): boolean {
  if (!profile) return false;
  if (profile.role === 'admin') return true;
  const perms = profile.permissions;
  if (!perms) return true;
  if (perms.full) return true;
  const v = perms[cap];
  if (v === false) return false;
  return true;
}

/** Whether the user can see a given plugin in the sidebar. */
export function canSeePlugin(profile: Profile | undefined | null, pluginId: string): boolean {
  if (!profile) return false;
  if (profile.role === 'admin') return true;
  const perms = profile.permissions;
  if (!perms || perms.full || perms.plugins === 'all') return true;
  return Array.isArray(perms.plugins) && perms.plugins.includes(pluginId);
}

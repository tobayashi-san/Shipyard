export const state = {
  currentView: 'dashboard',
  previousView: null,
  selectedServerId: null,
  currentPluginId: null,
  servers: [],
  plugins: [],
  ws: null,
  whiteLabel: {},
  user: null,
};

let serversRefreshPromise = null;
let refreshServersImpl = async () => state.servers;
let renderSidebarImpl = () => {};
let refreshDashboardDataImpl = () => {};
let refreshServersInPlaceImpl = async () => {};

export function setStateDependencies({
  refreshServers,
  renderSidebar,
  refreshDashboardData,
  refreshServersInPlace,
} = {}) {
  if (typeof refreshServers === 'function') refreshServersImpl = refreshServers;
  if (typeof renderSidebar === 'function') renderSidebarImpl = renderSidebar;
  if (typeof refreshDashboardData === 'function') refreshDashboardDataImpl = refreshDashboardData;
  if (typeof refreshServersInPlace === 'function') refreshServersInPlaceImpl = refreshServersInPlace;
}

export function hasCap(key) {
  const p = state.user?.permissions;
  if (!p) return false;
  if (p.full) return true;
  return !!p[key];
}

export function normalizeServer(server) {
  return {
    ...server,
    services: typeof server.services === 'string' ? JSON.parse(server.services) : server.services || [],
    tags: typeof server.tags === 'string' ? JSON.parse(server.tags) : server.tags || [],
  };
}

export async function refreshServersState({ renderCurrentView = false, reason = 'manual' } = {}) {
  if (serversRefreshPromise) return serversRefreshPromise;
  serversRefreshPromise = (async () => {
    const servers = await refreshServersImpl();
    state.servers = servers.map(normalizeServer);
    document.dispatchEvent(new CustomEvent('shipyard:servers-refreshed', {
      detail: { reason, servers: state.servers },
    }));

    if (renderCurrentView) {
      if (state.currentView === 'dashboard') {
        refreshDashboardDataImpl();
      } else if (state.currentView === 'servers') {
        await refreshServersInPlaceImpl();
      } else if (state.currentView === 'plugin') {
        renderSidebarImpl();
      }
    } else if (state.currentView === 'plugin') {
      renderSidebarImpl();
    }

    return state.servers;
  })();

  try {
    return await serversRefreshPromise;
  } finally {
    serversRefreshPromise = null;
  }
}

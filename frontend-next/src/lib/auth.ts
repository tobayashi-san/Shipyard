/**
 * Auth state — shared with the legacy frontend via the same localStorage key.
 * Both UIs read/write `shipyard_token`. Logging out anywhere logs out everywhere.
 */
const TOKEN_KEY = 'shipyard_token';

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore quota/private-mode errors */ }
}

export function setOnUnauthorized(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

export function notifyUnauthorized(): void {
  setToken(null);
  if (onUnauthorized) onUnauthorized();
}

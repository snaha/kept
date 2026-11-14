import { readJsonPreference, readPreference, writePreference } from './preferences';
import { SubsonicAPI } from 'subsonic-api';
import { serverUrl } from './connection-security'
import { randomId } from './random-id'

type Creds = { url: string; username: string; password: string };

export const session = $state<{ api: SubsonicAPI | null; base: string; authQs: string; username: string; admin: boolean; error: string }>({
  api: null, base: '', authQs: '', username: '', admin: false, error: '',
});

// subsonic-api resolves failed responses instead of throwing
export function ok<T extends { status: string }>(r: T): T {
  if (r.status === 'failed') throw new Error((r as { error?: { message: string } }).error?.message ?? 'request failed');
  return r;
}

export async function login(c: Creds) {
  session.error = ''
  const base = serverUrl(c.url)
  // ponytail: one salt per install keeps cover and stream URLs identical across runs, so the browser cache serves them
  const salt = readPreference('auth.salt') || randomId()
  writePreference('auth.salt', salt);
  const api = new SubsonicAPI({
    url: base, auth: { username: c.username, password: c.password }, salt, reuseSalt: true,
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }),
  })
  const r = await api.ping(); // the library resolves failures, so check status ourselves
  if (r.status === 'failed') throw new Error(r.error.message);
  // ponytail: capture the token/salt query once so cover and stream URLs can be built synchronously
  const u = new URL(await api.getCoverArtURL({ id: '-' }));
  u.searchParams.delete('id');
  session.api = api; session.base = base; session.authQs = u.searchParams.toString(); session.username = c.username;
  session.admin = ok(await api.getUser({ username: c.username })).user.adminRole;
  writePreference('creds', JSON.stringify(c));
}

export function logout() { writePreference('creds', null); session.api = null; }

export async function restore() {
  session.error = ''
  const failed = (error: unknown) => {
    logout()
    session.error = error instanceof Error ? error.message : 'Login failed'
  }
  // HTTP links are supported for the user's trusted home network or Tailscale.
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('u') && h.get('p') && h.get('s')) {
    history.replaceState(null, '', location.pathname);
    try {
      const base = serverUrl(h.get('s')!)
      await login({ url: base, username: h.get('u')!, password: h.get('p')! })
    } catch (error) { failed(error) }
    return
  }
  // the desktop app injects its local server and account; otherwise use what the user typed last time
  if (window.desktop) {
    const status = await window.desktop.status();
    if (status.phase === 'ready') await login(status);
    return;
  }
  const saved = readJsonPreference<Partial<Creds> | null>('creds', null);
  if (saved && typeof saved.url === 'string' && typeof saved.username === 'string' && typeof saved.password === 'string') await login(saved as Creds).catch(failed)
}

export const coverUrl = (id: string | undefined, size = 300) =>
  id ? `${session.base}/rest/getCoverArt?id=${encodeURIComponent(id)}&size=${size}&${session.authQs}` : '';

export const streamUrl = (id: string) =>
  `${session.base}/rest/stream?id=${encodeURIComponent(id)}&${session.authQs}`;

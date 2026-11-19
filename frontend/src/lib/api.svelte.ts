import { readJsonPreference, readPreference, writePreference } from './preferences';
import { SubsonicAPI } from 'subsonic-api';
import { serverUrl } from './connection-security'
import { randomId } from './random-id'
import { setShareMode } from './control-client.svelte'

type Creds = { url: string; username: string; password: string; controlSecret?: string };

export const session = $state<{ api: SubsonicAPI | null; base: string; authQs: string; username: string; admin: boolean; error: string; controlSecret?: string }>({
  api: null, base: '', authQs: '', username: '', admin: false, error: '',
});

// subsonic-api resolves failed responses instead of throwing
export function ok<T extends { status: string }>(r: T): T {
  if (r.status === 'failed') throw new Error((r as { error?: { message: string } }).error?.message ?? 'request failed');
  return r;
}

export async function login({ url, username, password, controlSecret }: Creds) {
  session.error = ''
  const base = serverUrl(url)
  // ponytail: one salt per install keeps cover and stream URLs identical across runs, so the browser cache serves them
  const salt = readPreference('auth.salt') || randomId()
  writePreference('auth.salt', salt);
  const api = new SubsonicAPI({
    url: base, auth: { username, password }, salt, reuseSalt: true,
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }),
  })
  const r = await api.ping(); // the library resolves failures, so check status ourselves
  if (r.status === 'failed') throw new Error(r.error.message);
  // ponytail: capture the token/salt query once so cover and stream URLs can be built synchronously
  const u = new URL(await api.getCoverArtURL({ id: '-' }));
  u.searchParams.delete('id');
  const admin = ok(await api.getUser({ username })).user.adminRole;
  session.api = api; session.base = base; session.authQs = u.searchParams.toString(); session.username = username;
  session.admin = admin;
  session.controlSecret = controlSecret;
  writePreference('creds', JSON.stringify({ url, username, password, controlSecret }));
}

export function logout() { writePreference('creds', null); session.controlSecret = undefined; session.api = null; }

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
      const controlSecret = h.get('m') === 'control' ? h.get('c') || undefined : undefined
      await login({ url: base, username: h.get('u')!, password: h.get('p')!, controlSecret })
      if (controlSecret) setShareMode('control')
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
  if (saved && typeof saved.url === 'string' && typeof saved.username === 'string' && typeof saved.password === 'string') {
    const { url, username, password } = saved
    const controlSecret = typeof saved.controlSecret === 'string' ? saved.controlSecret : undefined
    await login({ url, username, password, controlSecret }).catch(failed)
  }
}

export const coverUrl = (id: string | undefined, size = 300) =>
  id ? `${session.base}/rest/getCoverArt?id=${encodeURIComponent(id)}&size=${size}&${session.authQs}` : '';

export const streamUrl = (id: string) =>
  `${session.base}/rest/stream?id=${encodeURIComponent(id)}&${session.authQs}`;

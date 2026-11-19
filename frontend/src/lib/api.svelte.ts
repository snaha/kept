import { readJsonPreference, readPreference, writePreference } from './preferences';
import { SubsonicAPI } from 'subsonic-api';
import { serverUrl } from './connection-security'
import { randomId } from './random-id'
import { rememberLanShare, type LanShare } from './lan-catalog'
import { playbackResolver } from './playback-ref'

type Creds = { url: string; username: string; password: string };
let loginRevision = 0

export const session = $state<{ api: SubsonicAPI | null; base: string; authQs: string; username: string; admin: boolean; error: string }>({
  api: null, base: '', authQs: '', username: '', admin: false, error: '',
});

// subsonic-api resolves failed responses instead of throwing
export function ok<T extends { status: string }>(r: T): T {
  if (r.status === 'failed') throw new Error((r as { error?: { message: string } }).error?.message ?? 'request failed');
  return r;
}

export function login(c: Creds) { return signIn(c) }

async function signIn(c: Creds, share?: Partial<LanShare>) {
  const mine = ++loginRevision
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
  if (mine !== loginRevision) return
  const lan = share !== undefined && !window.desktop && c.username === 'share' && share.origin === location.origin
    && share.server === base && typeof share.key === 'string' && share.key
    ? { origin: share.origin, server: share.server, key: share.key } : undefined
  if (!window.desktop) playbackResolver.clear()
  rememberLanShare(lan)
  session.base = base
  session.authQs = u.searchParams.toString()
  session.username = c.username
  session.admin = false
  session.api = api
  const admin = ok(await api.getUser({ username: c.username })).user.adminRole
  if (mine !== loginRevision) return
  session.admin = admin
  writePreference('creds', JSON.stringify({ url: c.url, username: c.username, password: c.password, lan }))
}

export function logout() {
  loginRevision++
  rememberLanShare(undefined)
  if (!window.desktop) playbackResolver.clear()
  writePreference('creds', null); session.api = null;
}

export async function restore() {
  session.error = ''
  const failed = (error: unknown) => {
    logout()
    session.error = error instanceof Error ? error.message : 'Login failed'
  }
  const restoreAccount = async (c: Creds, share?: Partial<LanShare>) => {
    const attempt = signIn(c, share)
    const mine = loginRevision
    await attempt.catch(error => { if (mine === loginRevision) failed(error) })
  }
  // HTTP links are supported for the user's trusted home network or Tailscale.
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('u') && h.get('p') && h.get('s')) {
    history.replaceState(undefined, '', location.pathname)
    const server = h.get('s')!
    await restoreAccount({ url: server, username: h.get('u')!, password: h.get('p')! },
      { origin: h.get('origin') ?? undefined, key: h.get('catalog') ?? undefined, server })
    return
  }
  // the desktop app injects its local server and account; otherwise use what the user typed last time
  if (window.desktop) {
    const status = await window.desktop.status();
    if (status.phase === 'ready') await login(status);
    return;
  }
  const saved = readJsonPreference<Partial<Creds> & { lan?: Partial<LanShare> }>('creds', {})
  if (saved && typeof saved.url === 'string' && typeof saved.username === 'string' && typeof saved.password === 'string') {
    await restoreAccount({ url: saved.url, username: saved.username, password: saved.password }, saved.lan)
  }
}

export const coverUrl = (id: string | undefined, size = 300) =>
  id ? `${session.base}/rest/getCoverArt?id=${encodeURIComponent(id)}&size=${size}&${session.authQs}` : '';

export const streamUrl = (id: string) =>
  `${session.base}/rest/stream?id=${encodeURIComponent(id)}&${session.authQs}`;

import { readPreference, writePreference } from './preferences'
import { session } from './api.svelte'
import { currentPageUrl, serverUrl } from './connection-security'
import { randomId } from './random-id'

const USER = 'share'
const HTTP_NO_CONTENT = 204
type ShareUser = Record<string, unknown> & { id: string; userName: string; isAdmin: boolean }
let operation = 0

function shareUser(value: unknown): ShareUser {
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string'
    || !('userName' in value) || typeof value.userName !== 'string'
    || !('isAdmin' in value) || typeof value.isAdmin !== 'boolean') {
    throw new Error('The server returned an invalid sharing account.')
  }
  return value as ShareUser
}

// Browser credentials belong to a normalized server (including its base path)
// and the account managing that server. Desktop credentials stay profile-local.
export async function shareLink(signal?: AbortSignal) {
  const current = ++operation
  const api = session.api
  const username = session.username
  const originalBase = session.base
  const base = serverUrl(originalBase)
  const page = currentPageUrl()
  const assertCurrent = () => {
    if (signal?.aborted || current !== operation || api !== session.api
      || originalBase !== session.base || username !== session.username || !session.admin) {
      throw new Error('Sharing was cancelled. Open Share again for the current account.')
    }
  }
  if (!api || !session.admin) throw new Error('Sign in as an administrator to share this library.')
  assertCurrent()
  const status = window.desktop ? await window.desktop.status() : undefined
  assertCurrent()
  const d = status?.share
  if (status && (!d?.password || serverUrl(status.url) !== base || status.username !== username)) {
    throw new Error('Open Share from this desktop profile’s own library.')
  }
  const ip = d ? await window.desktop!.lanIp() : ''
  assertCurrent()
  const lan = (value: string) => {
    const url = new URL(value)
    // Only rewrite local HTTP addresses. HTTPS certificates belong to their host.
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) url.hostname = __LAN_IP__
    return url.href
  }
  const frontend = d ? `http://${ip}:${d.webPort}/` : lan(`${page.origin}${page.pathname}`)
  const server = d ? `http://${ip}:${d.port}` : serverUrl(lan(base))
  serverUrl(frontend)
  serverUrl(server)
  const key = `share.password.v2:${JSON.stringify([base, username])}`
  let password = d?.password ?? readPreference(key)
  if (!password) {
    password = randomId()
    // Save before network work: concurrent attempts and retries use the same key.
    // Never import the legacy, unscoped share.password value.
    if (!writePreference(key, password)) throw new Error('Save your device preferences before sharing.')
  }

  const { token } = await api.navidromeSession() as { token: string }
  assertCurrent()
  const headers = { 'x-nd-authorization': `Bearer ${token}`, 'content-type': 'application/json' }
  const nd = async (path: string, init?: RequestInit): Promise<unknown> => {
    assertCurrent()
    const response = await fetch(`${base}/api${path}`, { ...init, headers, signal, redirect: 'error' })
    assertCurrent()
    if (!response.ok) throw new Error(`Navidrome ${response.status} on ${path}`)
    const value: unknown = response.status === HTTP_NO_CONTENT ? undefined : await response.json()
    assertCurrent()
    return value
  }
  const users = await nd('/user')
  if (!Array.isArray(users)) throw new Error('The server returned an invalid sharing account list.')
  const existing = users.map(shareUser).find(user => user.userName === USER)
  if (existing?.isAdmin) {
    throw new Error('The account named “share” is an administrator. Use a separate non-admin sharing account.')
  }
  // Recheck the role on every export, including when a password was already saved.
  // Explicitly constrain updates as well as creation to a non-admin account.
  if (existing) {
    await nd(`/user/${encodeURIComponent(existing.id)}`, {
      method: 'PUT', body: JSON.stringify({ ...existing, password, isAdmin: false }),
    })
  } else {
    await nd('/user', { method: 'POST', body: JSON.stringify({ userName: USER, name: 'Share', password, isAdmin: false }) })
  }

  assertCurrent()
  return `${frontend}#u=${USER}&p=${encodeURIComponent(password)}&s=${encodeURIComponent(server)}`
}

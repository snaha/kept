// A read-only window onto the library's catalog for phones and browsers on the LAN. It rides on the web server
// that serves the page, so it needs no CORS and opens no new port. A Share link supplies a catalog-only key
// which a device trades for an expiring session. Only the session token accompanies catalog requests.
// Only browse, search and details are offered, with the bridge's own validators and DTOs (IDs, never file paths).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { validateCatalogBridgeRequest } from '../shared/catalog-bridge.js'

export const LAN_PREFIX = '/__kept/lan/'
// The only bridge operations a LAN client may name. Anything else is refused before it reaches the bridge.
export const LAN_OPERATIONS = Object.freeze({
  'catalog-albums': 'catalogAlbums', 'catalog-album': 'catalogAlbum', 'catalog-search': 'catalogSearch', 'playback-links': 'playbackLinks',
})
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000
export const MAX_SESSIONS = 64
export const MAX_BODY_BYTES = 16 * 1024
export const CATALOG_WINDOW_MS = 10_000
export const MAX_CATALOG_CALLS = 200
export const LOGIN_WINDOW_MS = 60_000
export const MAX_LOGIN_FAILURES = 10
const HTTP_OK = 200
const HTTP_BAD_REQUEST = 400
const HTTP_UNAUTHORIZED = 401
const HTTP_FORBIDDEN = 403
const HTTP_NOT_FOUND = 404
const HTTP_METHOD_NOT_ALLOWED = 405
const HTTP_PAYLOAD_TOO_LARGE = 413
const HTTP_TOO_MANY = 429
const HTTP_SERVER_ERROR = 500
// A response that names a place on disk is a bug, never something to send.
const PATH_KEYS = new Set(['path', 'paths', 'filePath', 'filepath', 'file', 'files', 'folder', 'directory', 'locations', 'location'])

const digest = value => createHash('sha256').update(value).digest()
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(digest(a), digest(b))
export function createLanShare(password, addresses) {
  if (!password || !addresses) return undefined
  const { origin, server } = addresses
  const key = createHmac('sha256', password).update(JSON.stringify(['kept-lan-catalog', origin, server])).digest('base64url')
  return { origin, server, key }
}
const hasPath = value => Array.isArray(value) ? value.some(hasPath)
  : value && typeof value === 'object' ? Object.entries(value).some(([key, item]) => PATH_KEYS.has(key) || hasPath(item)) : false

class Refusal extends Error {
  constructor(status, message) { super(message); this.status = status }
}

async function readJson(req) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new Refusal(HTTP_BAD_REQUEST, 'Expected JSON')
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Refusal(HTTP_PAYLOAD_TOO_LARGE, 'Request too large')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Refusal(HTTP_BAD_REQUEST, 'Invalid JSON') }
}

/**
 * Changing the share password invalidates sessions and links derived from it.
 */
export function createLanCatalog({ bridge, sharePassword, shareAddresses, now = Date.now, ttlMs = SESSION_TTL_MS }) {
  const sessions = new Map()
  const logins = new Map()
  const calls = new Map()
  let nextLoginPruneAt = 0
  const fingerprint = () => digest(sharePassword() ?? '').toString('hex')
  const recent = (table, key, window) => {
    const cutoff = now() - window
    const times = (table.get(key) ?? []).filter(time => time > cutoff)
    if (times.length) table.set(key, times)
    else table.delete(key)
    return times
  }
  const dropSession = id => {
    sessions.delete(id)
    calls.delete(id)
  }
  const prune = () => {
    for (const [id, session] of sessions) if (session.expiresAt <= now()) dropSession(id)
    while (sessions.size >= MAX_SESSIONS) dropSession(sessions.keys().next().value)
  }
  const loginFailures = remote => {
    const time = now()
    if (time >= nextLoginPruneAt) {
      const cutoff = time - LOGIN_WINDOW_MS
      for (const [address, times] of logins) {
        if (times.at(-1) <= cutoff) logins.delete(address)
      }
      nextLoginPruneAt = time + LOGIN_WINDOW_MS
    }
    const failures = recent(logins, remote, LOGIN_WINDOW_MS)
    if (failures.length >= MAX_LOGIN_FAILURES) throw new Refusal(HTTP_TOO_MANY, 'Too many attempts')
    return failures
  }
  const send = (res, status, body) => {
    if (res.destroyed) return
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const sessionOf = req => {
    const match = /^Bearer ([\w-]{20,128})$/.exec(String(req.headers.authorization ?? ''))
    const id = match ? digest(match[1]).toString('hex') : undefined
    const found = id ? sessions.get(id) : undefined
    if (!found || found.host !== req.headers.host) throw new Refusal(HTTP_UNAUTHORIZED, 'Sign in again')
    if (found.expiresAt <= now() || found.fingerprint !== fingerprint()) {
      dropSession(id)
      throw new Refusal(HTTP_UNAUTHORIZED, 'Sign in again')
    }
    return { id, found }
  }
  async function open(req, remote) {
    loginFailures(remote)
    const body = await readJson(req)
    const failures = loginFailures(remote)
    const expected = createLanShare(sharePassword(), shareAddresses())
    const host = req.headers.host
    if (!expected || host !== new URL(expected.origin).host || body?.server !== expected.server || !same(body?.key, expected.key)) {
      failures.push(now())
      logins.set(remote, failures)
      throw new Refusal(HTTP_UNAUTHORIZED, 'Wrong credentials')
    }
    prune()
    const token = randomBytes(32).toString('base64url')
    const expiresAt = now() + ttlMs
    sessions.set(digest(token).toString('hex'), { expiresAt, fingerprint: fingerprint(), host })
    return { token, expiresAt }
  }
  async function catalog(req, operation) {
    const { id } = sessionOf(req)
    const used = recent(calls, id, CATALOG_WINDOW_MS)
    if (used.length >= MAX_CATALOG_CALLS) throw new Refusal(HTTP_TOO_MANY, 'Slow down')
    used.push(now())
    calls.set(id, used)
    const method = LAN_OPERATIONS[operation]
    if (!method) throw new Refusal(HTTP_FORBIDDEN, 'Not available on this connection')
    const body = await readJson(req)
    let request
    try { request = validateCatalogBridgeRequest(operation, body === undefined ? [] : [body]) } catch { throw new Refusal(HTTP_BAD_REQUEST, 'Invalid catalog request') }
    const value = await bridge[method](request)
    if (hasPath(value)) throw new Error('A catalog response named a file path')
    return value
  }
  return {
    // Returns false for URLs that are not ours, so the caller serves the page as before.
    handle(req, res, pathname) {
      if (!pathname.startsWith(LAN_PREFIX)) return false
      void (async () => {
        try {
          const name = pathname.slice(LAN_PREFIX.length)
          if (req.method !== 'POST') throw new Refusal(HTTP_METHOD_NOT_ALLOWED, 'Not allowed')
          if (name === 'session') return send(res, HTTP_OK, await open(req, req.socket.remoteAddress ?? ''))
          if (!name.startsWith('catalog/') || name.includes('/', 'catalog/'.length)) throw new Refusal(HTTP_NOT_FOUND, 'Unknown request')
          send(res, HTTP_OK, { value: await catalog(req, name.slice('catalog/'.length)) })
        } catch (error) {
          if (error instanceof Refusal) send(res, error.status, { error: error.message })
          else { console.error('Kept LAN catalog:', error.message); send(res, HTTP_SERVER_ERROR, { error: 'The catalog is not available' }) }
        }
      })()
      return true
    },
    revokeAll() {
      sessions.clear()
      calls.clear()
    },
    sessions: () => sessions.size,
  }
}

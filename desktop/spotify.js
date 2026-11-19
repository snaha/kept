import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isSpotifyTrackId, spotifyTrackUri } from '../shared/spotify-source.js'

// Spotify as a playback-only provider, run entirely in the main process. The user signs in with their own
// client ID (PKCE, no client secret). Tokens are encrypted with safeStorage. The window only sees a status
// and asks for the few commands below. Audio stays on the Spotify device. Kept's queue and listening
// history retain track references and display details after sign-out.
const ACCOUNTS = 'https://accounts.spotify.com'
const API = 'https://api.spotify.com/v1'
const PLAYBACK_STATE = '/me/player'
const SCOPES = 'user-read-playback-state user-modify-playback-state'
const CLIENT_ID_PATTERN = /^[a-f\d]{32}$/i
const TOKEN_FILE = 'tokens.bin'
const CONFIG_FILE = 'config.json'
const REQUEST_TIMEOUT_MS = 15000
const LOGIN_TIMEOUT_MS = 600000
const EXPIRY_MARGIN_MS = 60000
const MS_PER_SECOND = 1000
const RETRY_DELAY_MS = 10000
const VERIFIER_BYTES = 48
const STATE_BYTES = 24
const SEARCH_LIMIT = 20
const MAX_QUERY = 200
const CALLBACK_PORT = 8888
const LOOPBACK = '127.0.0.1'
const HTTP_OK = 200
const HTTP_NO_CONTENT = 204
const HTTP_BAD_REQUEST = 400
const HTTP_UNAUTHORIZED = 401
const HTTP_FORBIDDEN = 403
const HTTP_NOT_FOUND = 404
const HTTP_TOO_MANY_REQUESTS = 429
const HTTP_SERVER_ERROR = 500
const SIGN_IN_EXPIRED = 'Spotify sign-in expired. Sign in again in Settings.'
const SIGN_IN_CHANGED = 'Spotify sign-in changed.'
const RATE_LIMITED = 'Spotify is rate-limiting requests. Try again later.'
const TOKEN_UNAVAILABLE = 'Spotify sign-in is temporarily unavailable. Kept will retry when needed.'

export class SpotifyError extends Error {
  constructor(message, status = 0, { code, retryAfterMs } = {}) {
    super(message)
    this.status = status
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

const readJson = async (file, fallback) => { try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback } }

function rateLimitError(response, now) {
  const header = response.headers.get('Retry-After')?.trim() ?? ''
  const delay = /^\d+$/.test(header) ? Number(header) * MS_PER_SECOND : Date.parse(header) - now
  const retryAfterMs = Number.isFinite(delay) && delay >= 0 ? delay : RETRY_DELAY_MS
  return new SpotifyError(RATE_LIMITED, HTTP_TOO_MANY_REQUESTS, { retryAfterMs })
}

// The default browser round trip: open the authorize URL, wait for the redirect on a loopback port.
export function loopbackAuthorize({ openExternal, port = CALLBACK_PORT, timeoutMs = LOGIN_TIMEOUT_MS, makeServer = createServer }) {
  return ({ buildUrl, state, signal }) => new Promise((resolve, reject) => {
    let timer
    let redirectUri = ''
    let finished = false
    const server = makeServer((request, response) => {
      const url = typeof request.url === 'string' ? URL.parse(request.url, `http://${LOOPBACK}`) : undefined
      if (!url) {
        response.writeHead(HTTP_BAD_REQUEST).end('Invalid callback URL.')
        return
      }
      if (finished || url.pathname !== '/callback') {
        response.writeHead(HTTP_NOT_FOUND).end()
        return
      }
      if (url.searchParams.get('state') !== state) {
        response.writeHead(HTTP_BAD_REQUEST).end('Invalid login state.')
        return
      }
      response.writeHead(HTTP_OK, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('Return to Kept. You may close this tab.')
      const code = url.searchParams.get('code')
      finish(url.searchParams.has('error') || !code ? new Error('Spotify sign-in was cancelled.') : undefined, code)
    })
    const cancel = () => finish(new Error('Spotify sign-in was cancelled.'))
    function finish(error, code) {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      server.close()
      if (error) reject(error)
      else resolve({ code, redirectUri })
    }
    if (signal?.aborted) return cancel()
    signal?.addEventListener('abort', cancel, { once: true })
    server.on('error', error => finish(error.code === 'EADDRINUSE' ? new Error(`Spotify sign-in needs local port ${port}. Close the application using it and retry.`) : error))
    timer = setTimeout(() => finish(new Error('Spotify sign-in timed out. Try again.')), timeoutMs)
    server.listen(port, LOOPBACK, async () => {
      if (finished) return
      redirectUri = `http://${LOOPBACK}:${server.address().port}/callback`
      try {
        await openExternal(buildUrl(redirectUri))
      } catch (error) {
        finish(error)
      }
    })
  })
}

export function createSpotifyService({ directory, safeStorage, authorize, fetchImpl = fetch, now = Date.now, onChange = () => {}, onConsent = async () => {} }) {
  let config = { clientId: '', deviceId: '', deviceName: '' }
  let tokens
  let generation = 0
  let authorizing
  let refreshing
  let refreshFailure
  let playbackRetryAt = 0
  let playbackDeviceId
  let error = ''
  let writeTail = Promise.resolve()

  const status = () => ({ connected: Boolean(tokens), account: tokens?.account ?? '', clientId: config.clientId, deviceId: config.deviceId, deviceName: config.deviceName, error })
  const emit = () => onChange(status())
  const stale = mine => mine !== generation

  // Serialize persistence and consent changes so the latest sign-in or sign-out owns the result.
  const write = operation => {
    writeTail = writeTail.catch(() => {}).then(operation)
    return writeTail
  }
  const persist = (name, bytes, mine) => write(async () => {
    if (stale(mine)) return
    const file = path.join(directory, name)
    await writeFile(`${file}.tmp`, bytes, { mode: 0o600 })
    if (stale(mine)) await rm(`${file}.tmp`, { force: true })
    else await rename(`${file}.tmp`, file)
  })
  const saveConfig = () => persist(CONFIG_FILE, JSON.stringify(config), generation)
  const saveTokens = () => {
    if (!safeStorage.isEncryptionAvailable()) throw new SpotifyError('OS credential encryption is unavailable. Spotify was not signed in.')
    return persist(TOKEN_FILE, safeStorage.encryptString(JSON.stringify(tokens)), generation)
  }

  async function tokenRequest(body) {
    const response = await fetchImpl(`${ACCOUNTS}/api/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.status === HTTP_TOO_MANY_REQUESTS) throw rateLimitError(response, now())
    if (!response.ok) {
      const clientError = response.status >= HTTP_BAD_REQUEST && response.status < HTTP_SERVER_ERROR
      const reply = clientError ? await response.json().catch(() => ({})) : undefined
      const message = clientError ? 'Spotify sign-in was rejected. Check your client ID and sign in again.' : TOKEN_UNAVAILABLE
      throw new SpotifyError(message, response.status, { code: reply?.error })
    }
    return response.json()
  }
  const withExpiry = (previous, token) => ({ ...previous, ...token, refresh_token: token.refresh_token ?? previous.refresh_token, expiresAt: now() + token.expires_in * MS_PER_SECOND })

  async function refresh(mine) {
    let token
    try {
      token = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: config.clientId })
    } catch (failure) {
      if (stale(mine)) throw new SpotifyError(SIGN_IN_CHANGED, HTTP_UNAUTHORIZED)
      if (failure instanceof SpotifyError && failure.code === 'invalid_grant') {
        await signOut(SIGN_IN_EXPIRED)
        throw new SpotifyError(SIGN_IN_EXPIRED, HTTP_UNAUTHORIZED)
      }
      const reason = failure instanceof SpotifyError ? failure : new SpotifyError(TOKEN_UNAVAILABLE)
      const retryAfterMs = Math.max(RETRY_DELAY_MS, reason.retryAfterMs ?? 0)
      refreshFailure = { mine, retryAt: now() + retryAfterMs, reason }
      error = reason.message
      emit()
      throw new SpotifyError(reason.message, reason.status, { retryAfterMs })
    }
    if (stale(mine)) throw new SpotifyError(SIGN_IN_CHANGED, HTTP_UNAUTHORIZED)
    tokens = withExpiry(tokens, token)
    await saveTokens()
    if (stale(mine)) throw new SpotifyError(SIGN_IN_CHANGED, HTTP_UNAUTHORIZED)
    refreshFailure = undefined
    if (error) {
      error = ''
      emit()
    }
    return token.access_token
  }

  async function accessToken() {
    if (!tokens) throw new SpotifyError('Sign in to Spotify in Settings first.', HTTP_UNAUTHORIZED)
    const mine = generation
    if (refreshing?.mine === mine) return refreshing.request
    if (refreshFailure?.mine === mine) {
      const retryAfterMs = refreshFailure.retryAt - now()
      if (retryAfterMs > 0) throw new SpotifyError(refreshFailure.reason.message, refreshFailure.reason.status, { retryAfterMs })
    }
    if (tokens.expiresAt > now() + EXPIRY_MARGIN_MS) return tokens.access_token
    const request = refresh(mine).finally(() => {
      if (refreshing?.mine === mine) refreshing = undefined
    })
    refreshing = { mine, request }
    return request
  }

  async function api(endpoint, { method = 'GET', body } = {}) {
    const mine = generation
    const token = await accessToken()
    if (stale(mine)) throw new SpotifyError(SIGN_IN_CHANGED, HTTP_UNAUTHORIZED)
    const response = await fetchImpl(`${API}${endpoint}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (stale(mine)) throw new SpotifyError(SIGN_IN_CHANGED, HTTP_UNAUTHORIZED)
    if (response.status === HTTP_NO_CONTENT) return undefined
    if (response.status === HTTP_TOO_MANY_REQUESTS) throw rateLimitError(response, now())
    if (!response.ok) {
      const message = response.status === HTTP_FORBIDDEN ? 'Spotify denied access. Check Premium and the app allowlist.'
        : response.status === HTTP_NOT_FOUND ? 'No Spotify device is active. Open Spotify on a device and choose it in Settings.'
        : response.status === HTTP_UNAUTHORIZED ? 'Sign in to Spotify again in Settings.' : `Spotify request failed (${response.status}).`
      throw new SpotifyError(message, response.status)
    }
    return response.json().catch(() => ({}))
  }

  const trackOf = item => item && item.type === 'track' && isSpotifyTrackId(item.id) ? {
    id: item.id, title: String(item.name ?? ''), artist: (item.artists ?? []).map(artist => artist.name).join(', '), album: String(item.album?.name ?? ''),
    duration: (item.duration_ms ?? 0) / MS_PER_SECOND,
  } : undefined

  // Forget credentials on explicit sign-out or when Spotify rejects the refresh grant.
  async function signOut(message = '') {
    const mine = ++generation
    authorizing?.abort()
    tokens = undefined
    refreshing = undefined
    refreshFailure = undefined
    playbackRetryAt = 0
    playbackDeviceId = undefined
    config = { clientId: config.clientId, deviceId: '', deviceName: '' }
    error = message
    try {
      const remove = write(() => rm(path.join(directory, TOKEN_FILE), { force: true }))
      const saved = saveConfig()
      const consent = write(() => onConsent('denied'))
      await Promise.all([remove, saved, consent])
    } catch (failure) {
      if (!stale(mine) && !message) error = failure.message
      throw failure
    } finally {
      if (!stale(mine)) emit()
    }
    return status()
  }

  return {
    async init() {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      config = { ...config, ...await readJson(path.join(directory, CONFIG_FILE), {}) }
      if (safeStorage.isEncryptionAvailable()) {
        try { tokens = JSON.parse(safeStorage.decryptString(await readFile(path.join(directory, TOKEN_FILE)))) } catch { tokens = undefined }
      }
      return status()
    },
    status,

    // PKCE sign-in with the user's own client ID. A newer attempt or a sign-out supersedes this one.
    async connect(clientId) {
      if (typeof clientId !== 'string' || !CLIENT_ID_PATTERN.test(clientId)) throw new SpotifyError('Enter the 32-character Spotify client ID, not the client secret.')
      if (!safeStorage.isEncryptionAvailable()) throw new SpotifyError('OS credential encryption is unavailable.')
      const mine = ++generation
      authorizing?.abort()
      const attempt = new AbortController()
      authorizing = attempt
      const verifier = randomBytes(VERIFIER_BYTES).toString('base64url')
      const state = randomBytes(STATE_BYTES).toString('base64url')
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      const buildUrl = redirectUri => `${ACCOUNTS}/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, scope: SCOPES, redirect_uri: redirectUri, state, code_challenge_method: 'S256', code_challenge: challenge })}`
      const { code, redirectUri } = await authorize({ buildUrl, state, signal: attempt.signal }).finally(() => {
        if (authorizing === attempt) authorizing = undefined
      })
      if (stale(mine)) throw new SpotifyError('Spotify sign-in was cancelled.')
      const token = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier })
      if (stale(mine)) throw new SpotifyError('Spotify sign-in was cancelled.')
      const me = await fetchImpl(`${API}/me`, { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (!me.ok) throw new SpotifyError('Spotify denied access. Check Premium and the app allowlist.', me.status)
      const account = await me.json()
      if (stale(mine)) throw new SpotifyError('Spotify sign-in was cancelled.')
      await write(() => {
        if (!stale(mine)) return onConsent('granted')
      })
      if (stale(mine)) throw new SpotifyError('Spotify sign-in was cancelled.')
      const connected = ++generation
      config = { clientId, deviceId: '', deviceName: '' }
      tokens = { ...withExpiry({}, token), account: String(account.id) }
      refreshing = undefined
      refreshFailure = undefined
      playbackRetryAt = 0
      playbackDeviceId = undefined
      error = ''
      try {
        await Promise.all([saveTokens(), saveConfig()])
      } catch (failure) {
        if (!stale(connected)) await signOut(failure.message).catch(() => {})
        throw failure
      }
      if (stale(connected)) throw new SpotifyError('Spotify sign-in was cancelled.')
      emit()
      return status()
    },

    // Signing out forgets the tokens and the device and withdraws the consent. In-flight requests are dropped.
    disconnect: () => signOut(),

    async devices() {
      const { devices = [] } = await api('/me/player/devices')
      return devices.filter(device => device.id && !device.is_restricted).map(device => ({ id: device.id, name: String(device.name ?? ''), type: String(device.type ?? '') }))
    },
    async selectDevice(id) {
      const device = (await this.devices()).find(candidate => candidate.id === id)
      if (!device) throw new SpotifyError('Choose an available Spotify device.')
      config = { ...config, deviceId: device.id, deviceName: device.name }
      await saveConfig()
      emit()
      return status()
    },

    // Text search returns the track reference and details needed for playback and display.
    async search(query) {
      if (typeof query !== 'string' || !query.trim() || query.length > MAX_QUERY) throw new SpotifyError('Enter a search of up to 200 characters.')
      const found = await api(`/search?${new URLSearchParams({ q: query, type: 'track', limit: String(SEARCH_LIMIT) })}`)
      return (found.tracks?.items ?? []).map(trackOf).filter(Boolean)
    },

    // Only Play reads the setting. The rest of transport belongs to the device that accepted Play.
    async command(action, value) {
      if (action === 'play') {
        const target = config.deviceId
        if (!target) throw new SpotifyError('Choose a Spotify device in Settings first.', HTTP_NOT_FOUND)
        if (!isSpotifyTrackId(value)) throw new SpotifyError('Only Spotify tracks can be played.')
        const mine = generation
        await api(`/me/player/play?device_id=${encodeURIComponent(target)}`, { method: 'PUT', body: { uris: [spotifyTrackUri(value)], position_ms: 0 } })
        if (stale(mine)) throw new SpotifyError(SIGN_IN_CHANGED, HTTP_UNAUTHORIZED)
        playbackDeviceId = target
        return target
      }
      const target = playbackDeviceId
      if (action === 'pause') {
        if (!target) return
        try {
          await api(`/me/player/pause?device_id=${encodeURIComponent(target)}`, { method: 'PUT' })
        } catch (failure) {
          // A revoked grant has already dropped the device. A local handoff can proceed.
          if (tokens) throw failure
        }
        return
      }
      if (!target) throw new SpotifyError('Start a track on Spotify first.', HTTP_NOT_FOUND)
      const query = `device_id=${encodeURIComponent(target)}`
      if (action === 'resume') await api(`/me/player/play?${query}`, { method: 'PUT' })
      else if (action === 'seek' && Number.isFinite(value) && value >= 0) await api(`/me/player/seek?position_ms=${Math.round(value * MS_PER_SECOND)}&${query}`, { method: 'PUT' })
      else throw new SpotifyError('Unsupported Spotify command.')
    },
    async playback() {
      const remaining = playbackRetryAt - now()
      if (remaining > 0) return { retryAfterMs: remaining }
      const mine = generation
      let state
      try {
        state = await api(PLAYBACK_STATE)
      } catch (failure) {
        // A plain result carries the retry timing through Electron's context bridge.
        if (stale(mine) || !(failure instanceof SpotifyError) || failure.retryAfterMs === undefined) throw failure
        const time = now()
        playbackRetryAt = Math.max(playbackRetryAt, time + failure.retryAfterMs)
        return { retryAfterMs: playbackRetryAt - time }
      }
      if (!state?.item) return undefined
      return { deviceId: state.device?.id ?? '', playing: Boolean(state.is_playing), progress: (state.progress_ms ?? 0) / MS_PER_SECOND, trackId: state.item.id ?? '', duration: (state.item.duration_ms ?? 0) / MS_PER_SECOND }
    },
  }
}

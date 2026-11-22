import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createSpotifyService, defaultSpotifyClientId, loopbackAuthorize } from './spotify.js'
import { MusicStore } from './music-store.js'
import { SPOTIFY_PAUSE_TIMEOUT_MS } from '../shared/spotify-source.js'

const CLIENT_ID = 'a'.repeat(32)
const TRACK_ID = 'keptSpotifyTestTrack01'
const EXPIRES_IN = 3600
const MS_PER_SECOND = 1000
const OK = 200
const BAD_REQUEST = 400
const FORBIDDEN = 403
const TOO_MANY_REQUESTS = 429
const SERVICE_UNAVAILABLE = 503
const RETRY_AFTER_SECONDS = 17
const LOGIN_TIMEOUT_MS = 50
const TEST_PORT = 43210
const SPOTIFY_SEARCH_MAX = 10
const JSON_HEADERS = { 'Content-Type': 'application/json' }
const json = (body, status = OK) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })

// No real Spotify call: a fake fetch answers the three endpoints, and a fake storage "encrypts" by reversing.
function harness(t, options = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'kept-spotify-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const calls = [], consents = [], changes = []
  let time = 0
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: text => Buffer.from([...text].reverse().join('')),
    decryptString: bytes => [...bytes.toString()].reverse().join(''),
  }
  const fetchImpl = async (url, init = {}) => {
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body
    const call = { url: String(url), method: init.method ?? 'GET', body, authorization: init.headers?.Authorization }
    calls.push(call)
    const response = await options.respond?.(call)
    if (response) return response
    if (String(url).endsWith('/api/token')) return json({ access_token: `access-${body.grant_type}`, refresh_token: 'refresh-1', expires_in: EXPIRES_IN })
    if (String(url).endsWith('/v1/me')) return json({ id: 'user-1' })
    if (String(url).endsWith('/me/player/devices')) return json({ devices: [{ id: 'dev-1', name: 'Desk', type: 'Computer' }, { id: 'dev-2', name: 'Locked', type: 'Speaker', is_restricted: true }] })
    if (String(url).includes('/search')) return json({ tracks: { items: [{ type: 'track', id: TRACK_ID, name: 'Song', artists: [{ name: 'A' }, { name: 'B' }], album: { name: 'Album' }, duration_ms: 200000 }, { type: 'episode', id: 'x' }] } })
    return new Response(undefined, { status: 204 })
  }
  let authorizedUrl
  const authorize = async ({ buildUrl, state }) => { authorizedUrl = new URL(buildUrl('http://127.0.0.1:8888/callback')); assert.ok(state); return { code: 'the-code', redirectUri: 'http://127.0.0.1:8888/callback' } }
  const service = createSpotifyService({
    directory, safeStorage, authorize: options.authorize ?? authorize, defaultClientId: options.defaultClientId, fetchImpl, now: () => time,
    onChange: status => changes.push(status),
    onConsent: async value => {
      await options.onConsent?.(value)
      consents.push(value)
    },
  })
  return {
    directory, service, calls, consents, changes, safeStorage, authorizedUrl: () => authorizedUrl,
    advance: ms => { time += ms },
    expire: () => { time += EXPIRES_IN * MS_PER_SECOND },
    refreshes: () => calls.filter(call => call.body?.grant_type === 'refresh_token'),
  }
}

test('expired tokens share a refresh and keep the refresh token when Spotify omits it', async t => {
  const reply = Promise.withResolvers()
  const fixture = harness(t, { respond: call => {
    if (call.body?.grant_type === 'refresh_token') return reply.promise
  } })
  await fixture.service.init()
  await fixture.service.connect(CLIENT_ID)
  await fixture.service.playback()
  assert.equal(fixture.refreshes().length, 0)
  fixture.expire()
  const first = fixture.service.playback()
  const second = fixture.service.devices()
  reply.resolve(json({ access_token: 'access-refreshed', expires_in: EXPIRES_IN }))
  await Promise.all([first, second])
  const [exchange] = fixture.refreshes()
  assert.equal(fixture.refreshes().length, 1)
  assert.deepEqual(exchange.body, { grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: CLIENT_ID })
  assert.deepEqual(fixture.calls.slice(-2).map(call => call.authorization), ['Bearer access-refreshed', 'Bearer access-refreshed'])
  const stored = fixture.safeStorage.decryptString(readFileSync(path.join(fixture.directory, 'tokens.bin')))
  assert.equal(JSON.parse(stored).refresh_token, 'refresh-1')
})

test('a refresh that finishes after sign-out cannot bring the account back or call playback', async t => {
  const started = Promise.withResolvers()
  const reply = Promise.withResolvers()
  const fixture = harness(t, { respond: call => {
    if (call.body?.grant_type !== 'refresh_token') return
    started.resolve()
    return reply.promise
  } })
  await fixture.service.init()
  await fixture.service.connect(CLIENT_ID)
  fixture.expire()
  const result = fixture.service.playback()
  const rejected = assert.rejects(result, /sign-in changed/)
  await Promise.race([started.promise, result])
  await fixture.service.disconnect()
  reply.resolve(json({ access_token: 'stale-access', expires_in: EXPIRES_IN }))
  await rejected
  assert.equal(fixture.service.status().connected, false)
  assert.equal(existsSync(path.join(fixture.directory, 'tokens.bin')), false)
  assert.equal(fixture.calls.some(call => call.url.endsWith('/me/player')), false)
})

test('a pause whose deadline expires during token refresh never reaches the old device', async t => {
  const refreshStarted = Promise.withResolvers()
  const refreshReply = Promise.withResolvers()
  const fixture = harness(t, { respond: call => {
    if (call.body?.grant_type !== 'refresh_token') return
    refreshStarted.resolve()
    return refreshReply.promise
  } })
  await fixture.service.init()
  await fixture.service.connect(CLIENT_ID)
  await fixture.service.selectDevice('dev-1')
  await fixture.service.command('play', TRACK_ID)
  fixture.expire()

  const deadline = new AbortController()
  const timeout = AbortSignal.timeout
  t.mock.method(AbortSignal, 'timeout', ms => ms === SPOTIFY_PAUSE_TIMEOUT_MS ? deadline.signal : timeout(ms))
  const pause = fixture.service.command('pause')
  await refreshStarted.promise
  deadline.abort()
  refreshReply.resolve(json({ access_token: 'fixture-refreshed', expires_in: EXPIRES_IN }))
  await assert.rejects(pause, { name: 'AbortError' })
  assert.equal(fixture.calls.some(call => call.url.includes('/me/player/pause')), false)
})

test('an invalid refresh grant publishes a signed-out status and removes the stored credentials', async t => {
  const fixture = harness(t, { respond: call => {
    if (call.body?.grant_type === 'refresh_token') return json({ error: 'invalid_grant' }, BAD_REQUEST)
  } })
  await fixture.service.init()
  await fixture.service.connect(CLIENT_ID)
  fixture.expire()
  await assert.rejects(fixture.service.playback(), /sign-in expired/)
  assert.equal(fixture.changes.at(-1).connected, false)
  assert.match(fixture.changes.at(-1).error, /Sign in again/)
  assert.equal(existsSync(path.join(fixture.directory, 'tokens.bin')), false)
  await assert.rejects(fixture.service.playback(), /Sign in/)
  assert.equal(fixture.refreshes().length, 1)
})

for (const failure of ['network failure', 'server failure']) {
  test(`a refresh ${failure} preserves sign-in and backs off before retrying`, async t => {
    let attempts = 0
    const fixture = harness(t, { respond: call => {
      if (call.body?.grant_type !== 'refresh_token') return
      if (++attempts > 1) return
      if (failure === 'network failure') throw new TypeError('fetch failed')
      return json({}, SERVICE_UNAVAILABLE)
    } })
    await fixture.service.init()
    await fixture.service.connect(CLIENT_ID)
    fixture.expire()
    const [first, second] = await Promise.all([fixture.service.playback(), fixture.service.playback()])
    assert.ok(first.retryAfterMs > MS_PER_SECOND)
    assert.deepEqual(second, first)
    assert.equal(fixture.changes.at(-1).connected, true)
    assert.match(fixture.changes.at(-1).error, /temporarily unavailable/)
    fixture.advance(MS_PER_SECOND)
    assert.deepEqual(await fixture.service.playback(), { retryAfterMs: first.retryAfterMs - MS_PER_SECOND })
    assert.equal(fixture.refreshes().length, 1)
    fixture.advance(first.retryAfterMs - MS_PER_SECOND)
    assert.equal(await fixture.service.playback(), undefined)
    assert.equal(fixture.refreshes().length, 2)
    assert.equal(fixture.changes.at(-1).error, '')
  })
}

test('a playback 429 passes Retry-After through the bridge result and delays polling', async t => {
  let limited = true
  const fixture = harness(t, { respond: call => {
    if (limited && call.url.endsWith('/me/player')) {
      limited = false
      return new Response(undefined, { status: TOO_MANY_REQUESTS, headers: { 'Retry-After': String(RETRY_AFTER_SECONDS) } })
    }
  } })
  await fixture.service.init()
  await fixture.service.connect(CLIENT_ID)
  await fixture.service.selectDevice('dev-1')
  await fixture.service.command('play', TRACK_ID)
  const delay = RETRY_AFTER_SECONDS * MS_PER_SECOND
  assert.deepEqual(await fixture.service.playback(), { retryAfterMs: delay })
  await fixture.service.command('pause')
  assert.match(fixture.calls.at(-1).url, /me\/player\/pause/)
  const before = fixture.calls.length
  fixture.advance(delay - 1)
  assert.deepEqual(await fixture.service.playback(), { retryAfterMs: 1 })
  assert.equal(fixture.calls.length, before)
  fixture.advance(1)
  assert.equal(await fixture.service.playback(), undefined)
  assert.equal(fixture.calls.length, before + 1)
})

// Exercise the callback, timer and error handlers without requiring a network socket.
function loopbackHarness(t, listenError) {
  const urls = []
  const servers = []
  const authorize = loopbackAuthorize({
    port: TEST_PORT,
    timeoutMs: LOGIN_TIMEOUT_MS,
    openExternal: async url => { urls.push(new URL(url)) },
    makeServer: handle => {
      const server = createServer(handle)
      const entry = { open: false, server }
      servers.push(entry)
      t.mock.method(server, 'address', () => ({ port: TEST_PORT }))
      t.mock.method(server, 'listen', (_port, _host, listening) => {
        if (listenError) server.emit('error', listenError)
        else {
          assert.equal(servers.filter(candidate => candidate.open).length, 0, 'the callback port is free')
          entry.open = true
          listening()
        }
      })
      t.mock.method(server, 'close', () => { entry.open = false })
      return server
    },
  })
  const request = (url, index = 0) => {
    assert.equal(servers[index].open, true)
    let status
    const response = {
      writeHead(code) {
        status = code
        return response
      },
      end() {},
    }
    servers[index].server.emit('request', { url }, response)
    return status
  }
  return { authorize, servers, urls, request, callback: (query, index) => request(`/callback?${query}`, index) }
}

test('loopback sign-in refuses a mismatched state, then accepts the matching callback', async t => {
  const { authorize, servers, urls, callback } = loopbackHarness(t)
  const pending = authorize({ buildUrl: uri => uri, state: 'expected' })
  assert.equal(callback('state=wrong&code=ignored'), BAD_REQUEST)
  assert.equal(callback('state=expected&code=accepted'), OK)
  assert.deepEqual(await pending, { code: 'accepted', redirectUri: urls[0].href })
  assert.equal(servers[0].open, false)
})

test('loopback rejects an invalid URL and keeps the sign-in pending for the valid callback', async t => {
  const { authorize, servers, request, callback } = loopbackHarness(t)
  const pending = authorize({ buildUrl: uri => uri, state: 'expected' })
  assert.equal(request('http://'), BAD_REQUEST)
  assert.equal(servers[0].open, true)
  assert.equal(callback('state=expected&code=accepted'), OK)
  assert.equal((await pending).code, 'accepted')
})

test('loopback sign-in times out and closes its listener', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { authorize, servers } = loopbackHarness(t)
  const pending = assert.rejects(authorize({ buildUrl: uri => uri, state: 'expected' }), /timed out/)
  assert.equal(servers[0].open, true)
  t.mock.timers.tick(LOGIN_TIMEOUT_MS)
  await pending
  assert.equal(servers[0].open, false)
})

test('loopback sign-in reports a port that is already in use', async t => {
  const failure = Object.assign(new Error('listen failed'), { code: 'EADDRINUSE' })
  const { authorize, urls } = loopbackHarness(t, failure)
  await assert.rejects(authorize({ buildUrl: uri => uri, state: 'expected' }), new RegExp(`needs local port ${TEST_PORT}`))
  assert.deepEqual(urls, [])
})

test('a replacement sign-in and sign-out both release the pending callback listener', async t => {
  const { authorize, servers, urls } = loopbackHarness(t)
  const { service, calls } = harness(t, { authorize })
  await service.init()
  const first = assert.rejects(service.connect(CLIENT_ID), /cancelled/)
  const second = assert.rejects(service.connect(CLIENT_ID), /cancelled/)
  await first
  assert.deepEqual(servers.map(server => server.open), [false, true])
  assert.equal(urls.length, 2)
  await service.disconnect()
  await second
  assert.deepEqual(servers.map(server => server.open), [false, false])
  assert.deepEqual(calls, [])
})

test('a failed consent grant does not publish or save a new sign-in', async t => {
  const fixture = harness(t, { onConsent: async () => { throw new Error('Consent unavailable') } })
  await fixture.service.init()
  await assert.rejects(fixture.service.connect(CLIENT_ID), /Consent unavailable/)
  assert.equal(fixture.service.status().connected, false)
  assert.deepEqual(fixture.changes, [])
  assert.equal(existsSync(path.join(fixture.directory, 'tokens.bin')), false)
})

test('a failed consent withdrawal still publishes sign-out and removes credentials', async t => {
  const fixture = harness(t, { onConsent: async value => {
    if (value === 'denied') throw new Error('Consent unavailable')
  } })
  await fixture.service.init()
  await fixture.service.connect(CLIENT_ID)
  await assert.rejects(fixture.service.disconnect(), /Consent unavailable/)
  assert.equal(fixture.changes.at(-1).connected, false)
  assert.match(fixture.changes.at(-1).error, /Consent unavailable/)
  assert.equal(existsSync(path.join(fixture.directory, 'tokens.bin')), false)
})

test('forbidden sign-in and playback point to Premium and the app allowlist', async t => {
  let blockSignIn = true
  const fixture = harness(t, { respond: call => {
    if ((blockSignIn && call.url.endsWith('/v1/me')) || call.url.endsWith('/me/player')) return json({}, FORBIDDEN)
  } })
  await fixture.service.init()
  await assert.rejects(fixture.service.connect(CLIENT_ID), /Check Premium and the app allowlist/)
  assert.equal(fixture.service.status().connected, false)
  blockSignIn = false
  await fixture.service.connect(CLIENT_ID)
  await assert.rejects(fixture.service.playback(), /Check Premium and the app allowlist/)
})

test('sign-in uses PKCE with the user client ID, stores tokens encrypted and grants the consent', async t => {
  const { directory, service, calls, consents, authorizedUrl } = harness(t)
  await service.init()
  assert.deepEqual(consents, [], 'nothing happens before the user signs in')
  await assert.rejects(service.connect('not-a-client-id'), /32-character/)
  assert.deepEqual(calls, [], 'a bad client ID makes no request')

  const status = await service.connect(CLIENT_ID)
  assert.deepEqual([status.connected, status.account, status.clientId], [true, 'user-1', CLIENT_ID])
  const url = authorizedUrl()
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID)
  const exchange = calls.find(call => call.url.endsWith('/api/token'))
  assert.equal(exchange.body.client_id, CLIENT_ID)
  assert.equal(createHash('sha256').update(exchange.body.code_verifier).digest('base64url'), url.searchParams.get('code_challenge'), 'the verifier matches the challenge')
  assert.ok(!('client_secret' in exchange.body))
  assert.deepEqual(consents, ['granted'])
  const stored = readFileSync(path.join(directory, 'tokens.bin'))
  assert.ok(!stored.toString().includes('access-authorization_code'), 'tokens are not stored in plain text')
  assert.ok(!readFileSync(path.join(directory, 'config.json'), 'utf8').includes('access-'))
})

test('sign-out clears the tokens, the device and the consent, and later commands make no request', async t => {
  const { directory, service, calls, consents, safeStorage } = harness(t)
  await service.init()
  await service.connect(CLIENT_ID)
  await service.selectDevice('dev-1')
  assert.equal(service.status().deviceId, 'dev-1')
  assert.ok(existsSync(path.join(directory, 'tokens.bin')))

  const out = await service.disconnect()
  assert.deepEqual([out.connected, out.deviceId, out.account], [false, '', ''])
  assert.equal(existsSync(path.join(directory, 'tokens.bin')), false)
  assert.equal(JSON.parse(readFileSync(path.join(directory, 'config.json'), 'utf8')).deviceId, '')
  assert.deepEqual(consents, ['granted', 'denied'])

  const before = calls.length
  await service.command('pause')
  await assert.rejects(service.search('song'), /Sign in/)
  assert.equal(calls.length, before, 'no request after sign-out')
  const restarted = createSpotifyService({ directory, safeStorage, authorize: async () => { throw new Error('unused') }, fetchImpl: async () => { throw new Error('unused') } })
  assert.equal((await restarted.init()).connected, false, 'a restart stays signed out')
})

test('a restart keeps the sign-in and the chosen device', async t => {
  const { directory, service, safeStorage, calls } = harness(t)
  await service.init(); await service.connect(CLIENT_ID); await service.selectDevice('dev-1')
  const restarted = createSpotifyService({ directory, safeStorage, authorize: async () => { throw new Error('unused') }, fetchImpl: async url => { calls.push({ url: String(url) }); return json({}) } })
  const status = await restarted.init()
  assert.deepEqual([status.connected, status.deviceId], [true, 'dev-1'])
})

test('commands go to the chosen device, accept only plain track IDs, and search returns display text only', async t => {
  const { service, calls } = harness(t)
  await service.init(); await service.connect(CLIENT_ID)
  assert.deepEqual((await service.devices()).map(device => device.id), ['dev-1'], 'a restricted device is not offered')
  await assert.rejects(service.command('play', TRACK_ID), /Choose a Spotify device/)
  await service.selectDevice('dev-1')
  await assert.rejects(service.selectDevice('dev-2'), /available Spotify device/)
  await assert.rejects(service.command('play', 'spotify:track:../../x'), /Only Spotify tracks/)
  await service.command('play', TRACK_ID)
  const play = calls.findLast(call => call.url.includes('/me/player/play'))
  assert.match(play.url, /device_id=dev-1/)
  assert.deepEqual(JSON.parse(play.body), { uris: [`spotify:track:${TRACK_ID}`], position_ms: 0 })
  assert.equal(play.authorization, 'Bearer access-authorization_code')
  await service.command('seek', 12.5)
  assert.match(calls.findLast(call => call.url.includes('/seek')).url, /position_ms=12500/)
  await assert.rejects(service.command('volume', 5), /Unsupported/)
  assert.deepEqual(await service.search('song'), [{ id: TRACK_ID, title: 'Song', artist: 'A, B', album: 'Album', duration: 200 }])
  const searched = new URL(calls.findLast(call => call.url.includes('/search')).url)
  assert.ok(Number(searched.searchParams.get('limit')) <= SPOTIFY_SEARCH_MAX, 'development-mode apps get a 400 above 10 results')
})

test('selecting another device leaves pause, resume and seek on the playing device until the next Play', async t => {
  const devices = ['dev-a', 'dev-b'].map(id => ({ id, name: id, type: 'Speaker' }))
  const { service, calls } = harness(t, { respond: call => {
    if (call.url.endsWith('/devices')) return json({ devices })
  } })
  await service.init()
  await service.connect(CLIENT_ID)
  await service.selectDevice('dev-a')
  assert.equal(await service.command('play', TRACK_ID), 'dev-a')
  await service.selectDevice('dev-b')
  await service.command('pause')
  await service.command('resume')
  await service.command('seek', 1)
  assert.equal(await service.command('play', TRACK_ID), 'dev-b')
  const transport = calls.filter(call => call.method === 'PUT')
  assert.deepEqual(transport.map(call => new URL(call.url).searchParams.get('device_id')), ['dev-a', 'dev-a', 'dev-a', 'dev-a', 'dev-b'])
})

test('durable history keeps a spotify occurrence beside local ones, with ids and display text only', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'kept-spotify-history-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const queue = [
    { id: 'local:track:1', rawId: '1', source: 'local', title: 'Local song', cover: '', available: true },
    { id: `spotify:track:${TRACK_ID}`, rawId: TRACK_ID, source: 'spotify', title: 'Spotify song', artist: 'A', cover: '', available: true, catalogRef: { kind: 'spotify', id: TRACK_ID } },
  ]
  const store = new MusicStore(path.join(directory, 'music.sqlite'))
  t.after(() => store.close())
  store.write({ scope: 'a', contexts: [{ id: 'mixed', queue, order: 'normal', permutation: [] }], entries: [0, 1].map(index => ({ id: `play-${index}`, contextId: 'mixed', index, cursor: index, playedAt: 1000 + index })) })
  const { entries } = store.list({ scope: 'a' })
  assert.deepEqual(entries.map(entry => entry.context.queue[entry.index].source).sort(), ['local', 'spotify'])
  const replayed = entries.find(entry => entry.index === 1).context.queue[1]
  assert.deepEqual(replayed.catalogRef, { kind: 'spotify', id: TRACK_ID }, 'the catalog ref survives, so it replays through the resolver')
  assert.equal(store.list({ scope: 'a', query: 'Spotify song' }).total, 1)
})

const KEPT_CLIENT_ID = 'b'.repeat(32)
const OWN_CLIENT_ID = 'c'.repeat(32)

test('a known client ID lets sign-in start without one, and a saved choice wins over it', async t => {
  const fixture = harness(t, { defaultClientId: async () => KEPT_CLIENT_ID })
  assert.equal((await fixture.service.init()).clientId, KEPT_CLIENT_ID)
  assert.ok(!existsSync(path.join(fixture.directory, 'config.json')), 'the default is not saved before sign-in')
  const status = await fixture.service.connect()
  assert.deepEqual([status.connected, status.clientId], [true, KEPT_CLIENT_ID])
  assert.equal(fixture.authorizedUrl().searchParams.get('client_id'), KEPT_CLIENT_ID)
  assert.equal(fixture.calls.find(call => call.url.endsWith('/api/token')).body.client_id, KEPT_CLIENT_ID)

  await fixture.service.connect(OWN_CLIENT_ID)
  const restarted = createSpotifyService({ directory: fixture.directory, safeStorage: fixture.safeStorage, defaultClientId: KEPT_CLIENT_ID, authorize: async () => { throw new Error('unused') }, fetchImpl: async () => { throw new Error('unused') } })
  assert.equal((await restarted.init()).clientId, OWN_CLIENT_ID, 'a client ID the user signed in with outlives the default')
  assert.equal((await restarted.disconnect()).clientId, OWN_CLIENT_ID, 'sign-out keeps the user’s own client ID')
})

test('a rotated default is used after sign-out while an existing grant refreshes with its original client ID', async t => {
  const fixture = harness(t, { defaultClientId: KEPT_CLIENT_ID })
  await fixture.service.init()
  await fixture.service.connect(KEPT_CLIENT_ID) // the one-button Settings path sends the displayed ID

  const rotatedClientId = 'd'.repeat(KEPT_CLIENT_ID.length)
  const refreshClients = []
  const options = {
    directory: fixture.directory, safeStorage: fixture.safeStorage, defaultClientId: rotatedClientId,
    now: () => EXPIRES_IN * MS_PER_SECOND,
    authorize: async () => { throw new Error('unused') },
    fetchImpl: async (_url, init) => {
      if (init.method === 'POST') {
        refreshClients.push(init.body.get('client_id'))
        return json({ access_token: 'fixture-refreshed', expires_in: EXPIRES_IN })
      }
      return json({ devices: [] })
    },
  }
  const restarted = createSpotifyService(options)
  const status = await restarted.init()
  assert.equal(status.connected, true)
  assert.equal(status.clientId, KEPT_CLIENT_ID)
  await restarted.devices()
  assert.deepEqual(refreshClients, [KEPT_CLIENT_ID])
  assert.equal((await restarted.disconnect()).clientId, rotatedClientId)
  assert.equal((await createSpotifyService(options).init()).clientId, rotatedClientId)
})

test('without any client ID, sign-in still asks for one and makes no request', async t => {
  const fixture = harness(t)
  assert.equal((await fixture.service.init()).clientId, '')
  await assert.rejects(fixture.service.connect(), /32-character/)
  assert.deepEqual(fixture.calls, [])
})

test('the default client ID comes from launch, then the build, then the regular Kept profile', async t => {
  const existing = mkdtempSync(path.join(os.tmpdir(), 'kept-existing-'))
  t.after(() => rmSync(existing, { recursive: true, force: true }))
  assert.equal(await defaultSpotifyClientId({ existingDirectory: existing }), '', 'no saved Spotify config')
  mkdirSync(path.join(existing, 'spotify'))
  writeFileSync(path.join(existing, 'spotify', 'config.json'), JSON.stringify({ clientId: OWN_CLIENT_ID, deviceId: 'ignored' }))
  assert.equal(await defaultSpotifyClientId({ existingDirectory: existing }), OWN_CLIENT_ID)
  assert.equal(await defaultSpotifyClientId({ build: { spotifyClientId: KEPT_CLIENT_ID }, existingDirectory: existing }), KEPT_CLIENT_ID)
  assert.equal(await defaultSpotifyClientId({ env: { SPOTIFY_CLIENT_ID: ` ${CLIENT_ID} ` }, build: { spotifyClientId: KEPT_CLIENT_ID } }), CLIENT_ID)
  assert.equal(await defaultSpotifyClientId({ env: { SPOTIFY_CLIENT_ID: 'a-client-secret?' }, build: { spotifyClientId: 'short' } }), '', 'malformed values are ignored')
})

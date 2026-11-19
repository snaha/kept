import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { createFakeCatalogService } from '../../shared/catalog-fake.js'
import { createCatalogBridge } from '../../shared/catalog-bridge.js'
import { createLanCatalog, createLanShare, LAN_OPERATIONS, MAX_CATALOG_CALLS, MAX_LOGIN_FAILURES } from '../../desktop/lan-catalog.js'
import { createVirtualCatalog } from '../src/lib/virtual-catalog.ts'
import { createPlaybackResolver } from '../src/lib/playback-ref.ts'
import { createLanCatalogClient, lanCatalog, openLanCatalog, rememberLanShare } from '../src/lib/lan-catalog.ts'

const SIZE = 4096
const T = 1000
const COVER_SIZE = 300
const HOUR_MS = 3_600_000
const TTL_MS = 12 * HOUR_MS
const OK = 200
const UNAUTHORIZED = 401
const FORBIDDEN = 403
const METHOD_NOT_ALLOWED = 405
const TOO_MANY = 429
const policy = { analysisAllowed: true, network: 'none' as const }
const folder = { id: 'folder', kind: 'local-folder' as const, label: 'Music', evidenceClass: 'deterministic' as const, licence: 'user' as const, policy }
const navidrome = { id: 'navidrome', kind: 'navidrome' as const, label: 'Navidrome', evidenceClass: 'deterministic' as const, licence: 'user' as const, policy: { ...policy, network: 'lan' as const } }
const record = { album: 'Record', albumArtist: 'Band', artist: 'Band', year: 1999, genre: 'Rock' }
const PATH_NAMES = ['nd-record/one.flac', 'nd-record/two.flac', 'nd-other/solo.flac']
const file = (name: string, albumId: string, track: number, tags: object) => ({ path: `${albumId}/${name}.flac`, contentHash: `hash-${name}`, size: SIZE, track, providerTrackId: `song-${name}`, providerAlbumId: albumId, tags })
const PASSWORD = 'fixture-share-secret'
const MUSIC_SERVER = 'http://music.example:4533'
const cover = (id: string | undefined, size = COVER_SIZE) => (id ? `cover:${id}:${size}` : '')

async function lan(options: { ttlMs?: number } = {}) {
  const service = createFakeCatalogService()
  await service.registerSource(folder)
  await service.registerSource(navidrome)
  const result = await service.ingestScan({
    sourceId: folder.id, providerSourceId: navidrome.id, observedAt: T, rootAvailable: true, complete: true, files: [
      file('one', 'nd-record', 1, { ...record, title: 'First' }), file('two', 'nd-record', 2, { ...record, title: 'Second' }),
      file('solo', 'nd-other', 1, { album: 'Another', artist: 'Aardvark', title: 'First light' }),
    ],
  } as Parameters<typeof service.ingestScan>[0])
  const bridge = createCatalogBridge(service)
  let clock = T
  let password = PASSWORD
  const writes: string[] = []
  const guarded = new Proxy(bridge, { get: (target, name: string) => (name in target && !Object.values(LAN_OPERATIONS).includes(name) ? (...args: unknown[]) => { writes.push(name); return (target as never as Record<string, (...a: unknown[]) => unknown>)[name](...args) } : (target as never)[name]) })
  const catalog = createLanCatalog({ bridge: guarded, sharePassword: () => password, shareAddresses: () => addresses, now: () => clock, ttlMs: options.ttlMs })
  const server = http.createServer((req, res) => { if (!catalog.handle(req, res, new URL(req.url ?? '/', 'http://x').pathname)) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>the page</html>') } })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const addresses = { origin, server: MUSIC_SERVER }
  const share = createLanShare(PASSWORD, addresses)!
  const raw = async (name: string, init: { method?: string; token?: string; body?: unknown } = {}) => {
    const response = await fetch(`${origin}/__kept/lan/${name}`, { method: init.method ?? 'POST', headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) }, body: init.method === 'GET' ? undefined : JSON.stringify(init.body ?? {}) })
    return { status: response.status, text: await response.text() }
  }
  const signIn = async () => JSON.parse((await raw('session', { body: share })).text).token as string
  return {
    service, bridge, catalog, origin, share, raw, signIn, writes, recordId: result.albumIds[0],
    advance: (ms: number) => { clock += ms }, rotatePassword: () => { password = 'rotated-fixture-password' },
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

test('rejects requests with no session, a wrong key, an expired token and a revoked one', async () => {
  const fixture = await lan({ ttlMs: HOUR_MS })
  try {
    assert.equal((await fixture.raw('catalog/catalog-albums')).status, UNAUTHORIZED)
    assert.equal((await fixture.raw('catalog/catalog-albums', { token: 'x'.repeat(43) })).status, UNAUTHORIZED)
    assert.equal((await fixture.raw('session', { body: { ...fixture.share, key: 'wrong-key' } })).status, UNAUTHORIZED)
    assert.equal((await fixture.raw('session', { body: { username: 'share', password: PASSWORD } })).status, UNAUTHORIZED)
    const token = await fixture.signIn()
    assert.equal((await fixture.raw('catalog/catalog-albums', { token })).status, 200)
    fixture.advance(HOUR_MS + 1)
    assert.equal((await fixture.raw('catalog/catalog-albums', { token })).status, UNAUTHORIZED, 'expired')
    const second = await fixture.signIn()
    assert.equal((await fixture.raw('catalog/catalog-albums', { token: second })).status, 200)
    fixture.catalog.revokeAll()
    assert.equal((await fixture.raw('catalog/catalog-albums', { token: second })).status, UNAUTHORIZED, 'revoked')
    const third = await fixture.signIn()
    fixture.rotatePassword()
    assert.equal((await fixture.raw('catalog/catalog-albums', { token: third })).status, UNAUTHORIZED, 'a rotated share password revokes its devices')
  } finally { await fixture.close() }
})

test('refuses writes, tools, consent and unknown operations without reaching the bridge', async () => {
  const fixture = await lan()
  try {
    const token = await fixture.signIn()
    for (const operation of ['set-trait', 'set-favorite', 'migrate', 'set-consent', 'consent', 'undo', 'tool', 'set-field', 'lock-field', 'undo-field', 'activity', 'album-review', 'albums', 'nothing']) {
      assert.equal((await fixture.raw(`catalog/${operation}`, { token, body: { albumId: fixture.recordId, field: 'title', value: 'x' } })).status, FORBIDDEN, operation)
    }
    for (const method of ['GET', 'PUT', 'DELETE']) assert.equal((await fixture.raw('catalog/catalog-albums', { method, token })).status, METHOD_NOT_ALLOWED, method)
    assert.equal((await fixture.raw('catalog/catalog-albums/extra', { token })).status, 404)
    assert.deepEqual(fixture.writes, [])
    const wrong = await fixture.raw('catalog/catalog-album', { token, body: { albumId: '../etc/passwd' } })
    assert.equal(wrong.status, 400, 'bridge validators run on every request')
    assert.equal((await fixture.raw('catalog/catalog-albums', { token, body: { limit: 100000 } })).status, 400)
  } finally { await fixture.close() }
})

test('the catalog exchange accepts only the Share key for its page and music server', async () => {
  const addresses = { origin: 'http://kept.example:8765', server: MUSIC_SERVER }
  const share = createLanShare(PASSWORD, addresses)!
  const catalog = createLanCatalog({ bridge: {}, sharePassword: () => PASSWORD, shareAddresses: () => addresses })
  const host = new URL(addresses.origin).host
  const open = (body: object, target = host) => new Promise<number>(resolve => {
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
      method: 'POST', headers: { host: target, 'content-type': 'application/json' }, socket: {},
    })
    let status = 0
    const response = { writeHead(code: number) { status = code }, end() { resolve(status) } }
    assert.equal(catalog.handle(request, response, '/__kept/lan/session'), true)
  })
  assert.equal(await open({ username: 'share', password: PASSWORD }), UNAUTHORIZED)
  assert.equal(await open({ ...share, server: 'http://another-music.example' }), UNAUTHORIZED)
  assert.equal(await open(share, 'other-kept.example:8765'), UNAUTHORIZED)
  assert.equal(await open(share), OK)
})

test('rate-limits catalog calls per device and failed sign-ins per address', async () => {
  const fixture = await lan()
  try {
    for (let attempt = 0; attempt < MAX_LOGIN_FAILURES; attempt++) assert.equal((await fixture.raw('session', { body: { ...fixture.share, key: 'wrong-key' } })).status, UNAUTHORIZED)
    assert.equal((await fixture.raw('session', { body: fixture.share })).status, TOO_MANY)
    fixture.advance(60_001)
    const token = await fixture.signIn()
    for (let call = 0; call < MAX_CATALOG_CALLS; call++) await fixture.raw('catalog/catalog-albums', { token })
    assert.equal((await fixture.raw('catalog/catalog-albums', { token })).status, TOO_MANY)
  } finally { await fixture.close() }
})

test('responses carry IDs and never a file path', async () => {
  const fixture = await lan()
  try {
    const token = await fixture.signIn()
    const { album } = await fixture.bridge.catalogAlbum({ albumId: fixture.recordId })
    const assetId = album!.tracks[0].assetId
    const bodies = [
      await fixture.raw('catalog/catalog-albums', { token }), await fixture.raw('catalog/catalog-album', { token, body: { albumId: fixture.recordId } }),
      await fixture.raw('catalog/catalog-search', { token, body: { query: 'first', albums: { offset: 0, limit: 5 }, tracks: { offset: 0, limit: 5 } } }),
      await fixture.raw('catalog/playback-links', { token, body: { assetIds: [assetId] } }),
    ]
    for (const body of bodies) {
      assert.equal(body.status, 200)
      for (const name of PATH_NAMES) assert.ok(!body.text.includes(name), `${name} leaked`)
      assert.ok(!/"(path|paths|locations|filePath)"/.test(body.text))
    }
  } finally { await fixture.close() }
})

test('the LAN client reads the same catalog as the desktop bridge for one anchor, and the provider yields identical tiles', async () => {
  const fixture = await lan()
  try {
    const { client, open } = createLanCatalogClient(fixture.share)
    await open()
    assert.deepEqual(await client.catalogAlbums({ sort: 'artist' }), await fixture.bridge.catalogAlbums({ sort: 'artist' }))
    assert.deepEqual(await client.catalogAlbum({ albumId: fixture.recordId }), await fixture.bridge.catalogAlbum({ albumId: fixture.recordId }))
    const query = { query: 'first', albums: { offset: 0, limit: 5 }, tracks: { offset: 0, limit: 5 } }
    assert.deepEqual(await client.catalogSearch(query), await fixture.bridge.catalogSearch(query))
    const provider = () => createVirtualCatalog({ resolver: createPlaybackResolver(), playbackSourceId: 'navidrome', cover })
    const tiles = async (source: typeof client) => (await Array.fromAsync(provider().albums(source, 'alphabeticalByArtist'))).flat()
    assert.deepEqual(await tiles(client), await tiles(fixture.bridge))
  } finally { await fixture.close() }
})

test('the client signs in again after a revocation, and gives up when the desktop refuses or is not Kept', async () => {
  const fixture = await lan()
  try {
    const { client, open } = createLanCatalogClient(fixture.share)
    await open()
    fixture.catalog.revokeAll()
    assert.equal((await client.catalogAlbums({})).total, 2, 'one silent sign-in')
    fixture.rotatePassword()
    await assert.rejects(client.catalogAlbums({}), /refused|not available/)
    await assert.rejects(createLanCatalogClient(fixture.share).open(), /refused/)
    // A server that answers with its page (not Kept) has no catalog: the caller falls back.
    await assert.rejects(createLanCatalogClient(fixture.share).client.catalogAlbums({}), /refused|not available/)
    const page = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html></html>') })
    await new Promise<void>(resolve => page.listen(0, '127.0.0.1', resolve))
    try { await assert.rejects(createLanCatalogClient({ ...fixture.share, origin: `http://127.0.0.1:${(page.address() as AddressInfo).port}` }).open(), /No catalog/) } finally { page.closeAllConnections(); page.close() }
  } finally { await fixture.close() }
})

test('the page falls back to the music server when the session is refused, and uses the catalog when it is valid', async () => {
  const fixture = await lan()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: fixture.origin } })
  try {
    rememberLanShare({ ...fixture.share, key: 'wrong-key' })
    assert.equal(await openLanCatalog(), undefined)
    assert.equal(lanCatalog(), undefined, 'unauthorised: Navidrome serves')
    rememberLanShare(undefined)
    assert.equal(await openLanCatalog(), undefined, 'a desktop window has its own bridge')
    rememberLanShare(fixture.share)
    assert.ok(await openLanCatalog())
    assert.equal((await lanCatalog()!.catalogAlbums({})).total, 2)
    rememberLanShare(undefined)
    assert.equal(lanCatalog(), undefined, 'a sign-out drops the old session')
  } finally {
    if (previous) Object.defineProperty(globalThis, 'location', previous)
    else delete (globalThis as { location?: unknown }).location
    rememberLanShare(undefined)
    await fixture.close()
  }
})

test('a sign-in that finishes after the account changed publishes nothing, and another server is another account', async () => {
  const fixture = await lan()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: fixture.origin } })
  try {
    rememberLanShare(fixture.share)
    const stale = openLanCatalog()
    rememberLanShare({ ...fixture.share, key: 'wrong-key' })
    await stale
    assert.equal(lanCatalog(), undefined, 'the old account does not publish under the new one')
    const fresh = openLanCatalog()
    rememberLanShare(fixture.share)
    const newest = openLanCatalog()
    await fresh
    assert.equal(lanCatalog(), undefined, 'superseded while pending')
    assert.ok(await newest)
    assert.ok(lanCatalog())
    rememberLanShare({ ...fixture.share, server: 'http://other.example' })
    assert.equal(lanCatalog(), undefined, 'the same login on another music server drops the catalog')
  } finally {
    if (previous) Object.defineProperty(globalThis, 'location', previous)
    else delete (globalThis as { location?: unknown }).location
    rememberLanShare(undefined)
    await fixture.close()
  }
})

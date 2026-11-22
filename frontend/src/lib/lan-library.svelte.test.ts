import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { login, logout, restore, session } from './api.svelte'
import { setCatalogEnabled } from './catalog-source.svelte'
import { disposeLibrary, library, setMode } from './library.svelte'
import { disposeHistory, listeningHistory, loadHistory } from './listening-history.svelte'
import type { Track } from './music'
import { resolveTrackPlayback } from './playback-ref'
import { disposePlayback, player, replayHistory } from './player.svelte'

const SERVER = 'http://music.example:4533'
const USER = 'share'
const PASSWORD = 'fixture-stream-password'
const CATALOG_KEY = 'fixture-catalog-only-key'
const ASSET_ID = 'asset:fixture'
const SONG_ID = 'fixture-song'
const PLAYED_AT = 1000
const SESSION_TTL_MS = 3_600_000
const MAX_FALLBACK_WAIT_MS = 500
const PROBE_DELAY_MS = 250
const catalogAlbum = {
  id: 'album:lan-fixture', title: 'Fixture catalog album', trackCount: 1,
  availability: 'available', addedAt: 0, links: [],
}
const page = { albums: [catalogAlbum], total: 1, version: 1 }
const localAlbum = { id: 'nav-fixture', name: 'Fixture server album', songCount: 1 }
const playlist = { id: 'playlist-fixture', name: 'Fixture playlist', songCount: 1 }
const creds = { url: SERVER, username: USER, password: PASSWORD }
const sessionReply = () => Response.json({ token: 'fixture-session-token', expiresAt: Date.now() + SESSION_TTL_MS })
const authReply = (adminRole = false) => subsonic({ user: { username: USER, adminRole } })
const value = (payload: unknown) => Response.json({ value: payload })
const subsonic = (payload: object) => {
  const body = JSON.stringify({ 'subsonic-response': { status: 'ok', ...payload } })
  const response = new Response(body, { headers: { 'content-type': 'application/json' } })
  // Chromium's native body read uses tasks outside the fake clock. Only the LAN gates should delay these fixtures.
  response.text = async () => body
  return response
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

class TestAudio extends EventTarget {
  static element: TestAudio | undefined
  src = ''
  constructor() { super(); TestAudio.element ??= this }
  async play() {}
  pause() {}
  load() {}
  removeAttribute() { this.src = '' }
}

let originalHref = ''
let request: ReturnType<typeof vi.fn<typeof fetch>>
let handle: (url: URL, init: RequestInit | undefined) => Response | Promise<Response> | undefined
let origin: string

function shareFragment(target = origin) {
  const hash = new URLSearchParams({ u: USER, p: PASSWORD, s: SERVER, origin: target, catalog: CATALOG_KEY })
  history.replaceState(undefined, '', `${location.pathname}#${hash}`)
}
const lanCalls = () => request.mock.calls.filter(([input]) => String(input).includes('/__kept/lan/'))

beforeEach(() => {
  if (typeof window === 'undefined') {
    vi.stubGlobal('window', globalThis)
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key),
      setItem: (key: string, saved: string) => storage.set(key, saved),
      removeItem: (key: string) => storage.delete(key),
    })
    let current = new URL('http://kept.example/')
    vi.stubGlobal('location', current)
    vi.stubGlobal('history', { replaceState: (_state: unknown, _unused: string, path: string) => {
      current = new URL(path, current)
      vi.stubGlobal('location', current)
    } })
  }
  vi.stubGlobal('Audio', TestAudio)
  TestAudio.element = undefined
  originalHref = location.href
  origin = location.origin
  logout()
  setCatalogEnabled(true)
  handle = () => undefined
  request = vi.fn(async (input, init) => {
    const url = new URL(String(input), origin)
    const reply = handle(url, init)
    if (reply) return reply
    if (url.origin === origin) {
      if (url.pathname.endsWith('/session')) return sessionReply()
      if (url.pathname.endsWith('/catalog-albums')) return value(page)
      throw new Error(`Unexpected catalog request: ${url.pathname}`)
    }
    if (url.pathname.includes('/getUser')) return authReply()
    if (url.pathname.includes('/getAlbumList2')) return subsonic({ albumList2: { album: [localAlbum] } })
    if (url.pathname.includes('/getPlaylists')) return subsonic({ playlists: { playlist: [playlist] } })
    return subsonic({})
  })
  vi.stubGlobal('fetch', request)
})
afterEach(() => {
  disposeHistory()
  disposePlayback()
  disposeLibrary()
  logout()
  history.replaceState(undefined, '', originalHref)
  localStorage.removeItem(`music.history.v1:${SERVER}:${USER}`)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('ordinary Navidrome login and mode changes keep credentials off the page origin', async () => {
  handle = url => url.pathname.includes('/getUser') ? authReply(true) : undefined
  await login({ ...creds, username: 'fixture-admin' })
  await setMode('albums')
  await setMode('playlists')
  await setMode('albums')
  expect(library.tiles.map(tile => tile.rawId)).toEqual([localAlbum.id])
  expect(request.mock.calls.every(([input]) => new URL(String(input)).origin === SERVER)).toBe(true)
})

test('the first Share album load sees the catalog even with getUser pending', async () => {
  const userRequest = deferred<void>()
  const user = deferred<Response>()
  handle = url => {
    if (!url.pathname.includes('/getUser')) return
    userRequest.resolve()
    return user.promise
  }
  shareFragment()
  const restoring = restore()
  await userRequest.promise
  try {
    expect(session.api).toBeTruthy()
    await setMode('albums')
    expect(library.tiles.map(tile => tile.rawId)).toEqual([catalogAlbum.id])
    const exchanges = lanCalls().filter(([input]) => String(input).endsWith('/session'))
    expect(exchanges).toHaveLength(1)
    expect(JSON.parse(String(exchanges[0][1]?.body))).toEqual({ key: CATALOG_KEY, server: SERVER })
  } finally {
    user.resolve(authReply())
    await restoring
  }
})

test('a Share fragment copied to a different page origin only opens Navidrome', async () => {
  shareFragment('http://different-kept.example')
  await restore()
  await setMode('albums')
  expect(library.tiles.map(tile => tile.rawId)).toEqual([localAlbum.id])
  expect(lanCalls()).toHaveLength(0)
})

test('browser history replays an asset from a saved Share account before opening its album', async () => {
  const track: Track = {
    id: 'local:track:fixture-occurrence', rawId: ASSET_ID, title: 'Fixture stored track',
    source: 'local', cover: '', available: true, catalogRef: { kind: 'asset', id: ASSET_ID },
  }
  const context = { id: 'fixture-history-context', queue: [track], order: 'normal', permutation: [] }
  localStorage.setItem('creds', JSON.stringify({ ...creds, lan: { origin, server: SERVER, key: CATALOG_KEY } }))
  localStorage.setItem(`music.history.v1:${SERVER}:${USER}`, JSON.stringify({
    contexts: [context], entries: [{ id: 'fixture-play', contextId: context.id, index: 0, playedAt: PLAYED_AT, cursor: 0 }],
  }))
  const reply = deferred<Response>()
  handle = url => url.pathname.endsWith('/playback-links') ? reply.promise : undefined
  await restore()
  expect(resolveTrackPlayback(track)).toBeUndefined()
  loadHistory()
  await vi.waitFor(() => expect(lanCalls().some(([input]) => String(input).endsWith('/playback-links'))).toBe(true))
  replayHistory(listeningHistory.entries[0])
  reply.resolve(value({ version: 1, links: { [ASSET_ID]: [{ sourceId: 'navidrome', externalId: SONG_ID }] } }))
  await vi.waitFor(() => expect(player.playing).toBe(true))
  expect(TestAudio.element?.src).toContain(`/rest/stream?id=${SONG_ID}`)
  expect(lanCalls().map(([input]) => new URL(String(input)).pathname.split('/').at(-1))).toEqual(['session', 'playback-links'])
})

test('Playlists load while a Share catalog sign-in is still pending', async () => {
  vi.useFakeTimers()
  const started = deferred<void>()
  const reply = deferred<Response>()
  handle = url => {
    if (!url.pathname.endsWith('/session')) return
    started.resolve()
    return reply.promise
  }
  shareFragment()
  await restore()
  const albums = setMode('albums')
  await started.promise
  const playlists = setMode('playlists')
  await vi.advanceTimersByTimeAsync(0)
  expect(library.loading).toBe(false)
  await playlists
  expect(library.tiles.map(tile => tile.rawId)).toEqual([playlist.id])
  reply.resolve(sessionReply())
  await albums
  expect(library.tiles.map(tile => tile.rawId)).toEqual([playlist.id])
})

test('a slow catalog probe falls back quickly, preserves visible albums and is reused', async () => {
  vi.useFakeTimers()
  const started = deferred<void>()
  const reply = deferred<Response>()
  const probing = vi.fn(() => { started.resolve(); return reply.promise })
  handle = (url, init) => url.pathname.endsWith('/catalog-albums') && String(init?.body).includes('"limit":1') ? probing() : undefined
  shareFragment()
  await restore()
  const initial = setMode('albums')
  await started.promise
  await vi.advanceTimersByTimeAsync(MAX_FALLBACK_WAIT_MS)
  expect(library.loading).toBe(false)
  await initial
  expect(library.tiles.map(tile => tile.rawId)).toEqual([localAlbum.id])

  const retry = setMode('albums')
  expect(library.tiles.map(tile => tile.rawId)).toEqual([localAlbum.id])
  await vi.advanceTimersByTimeAsync(MAX_FALLBACK_WAIT_MS)
  expect(library.loading).toBe(false)
  await retry
  expect(probing).toHaveBeenCalledOnce()
  reply.resolve(value(page))
  await vi.advanceTimersByTimeAsync(0)
  expect(library.tiles.map(tile => tile.rawId)).toEqual([localAlbum.id])
  await setMode('albums')
  expect(library.tiles.map(tile => tile.rawId)).toEqual([catalogAlbum.id])
  expect(probing).toHaveBeenCalledOnce()
})

test('the first LAN album page shares the probe deadline and cannot overwrite the fallback', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const probe = deferred<Response>()
  const firstPageStarted = deferred<void>()
  const firstPage = deferred<Response>()
  handle = (url, init) => {
    if (!url.pathname.endsWith('/catalog-albums')) return
    const { limit } = JSON.parse(String(init?.body))
    if (limit === 1) return probe.promise
    firstPageStarted.resolve()
    return firstPage.promise
  }

  shareFragment()
  await restore()
  const albums = setMode('albums')
  await vi.advanceTimersByTimeAsync(PROBE_DELAY_MS)
  probe.resolve(value(page))
  await firstPageStarted.promise
  await vi.advanceTimersByTimeAsync(MAX_FALLBACK_WAIT_MS - PROBE_DELAY_MS)
  expect(library.tiles.map(tile => tile.rawId)).toEqual([localAlbum.id])
  expect(library.loading).toBe(false)
  await albums

  firstPage.resolve(value(page))
  await vi.advanceTimersByTimeAsync(0)
  expect(library.tiles.map(tile => tile.rawId)).toEqual([localAlbum.id])
  await setMode('albums', true)
  expect(library.tiles.map(tile => tile.rawId)).toEqual([localAlbum.id])
  expect(library.error).toBe('')
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, cleanup } from 'vitest-browser-svelte'
import { tick } from 'svelte'
import type { SubsonicAPI } from 'subsonic-api'
import { session } from './api.svelte'
import { library, pick, setMode, songsOf, tileIdOf, watchCatalog } from './library.svelte'
import { catalogSearch, disposeCatalogSearch, moreCatalogSearch, startCatalogSearch } from './catalog-search.svelte'
import { catalogSource, primePlayback, setCatalogEnabled } from './catalog-source.svelte'
import { collectionPlayback, disposePlayback, player } from './player.svelte'
import { resolveTrackPlayback } from './playback-ref'
import { albumPlays, catalog, metadata, saveMetadata, syncDecisions, loadCatalog } from './discovery.svelte'
import { activity, loadActivity, resetActivity, undoActivity } from './activity.svelte'
import { createCatalogBridge, createFakeCatalogService, type CatalogBridge, type CatalogService, type ScanFile } from './catalog'
import type { JobsStatus } from './jobs.svelte'
import AlbumReview from './album-review.svelte'
import ActivityPanel from './activity-panel.svelte'
import CollectionDetails from './CollectionDetails.svelte'
import Settings from './Settings.svelte'
import Grid from './Grid.svelte'

const T1 = 1000, T2 = 2000
const SIZE = 4096
const SEARCH_SETTLE = 400, SAVE_DELAY = 300
// A background refresh is debounced and then reads the whole catalog; under a loaded browser that outlasts waitFor's 1 s default.
const REFRESH_WAIT = { timeout: 5000 }
const MANY_ALBUMS = 60
const policy = { analysisAllowed: true, network: 'none' } as const
const route = { kind: 'route', id: 'route-release' } as const
type Bridge = NonNullable<Window['musicCatalog']>
const ok = <T,>(value: T) => ({ status: 'ok', ...value })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
const song = (name: string, album: string, track: number, tags: ScanFile['tags']): ScanFile => ({ path: `${album}/${name}.flac`, contentHash: `hash-${album}-${name}`, size: SIZE, track, providerTrackId: `song-${album}-${name}`, providerAlbumId: album, tags })
const record = { album: 'Record', albumArtist: 'Band', artist: 'Band', year: 1999, genre: 'Rock' }
const LIBRARY = [
  song('one', 'nd-record', 1, { ...record, title: 'First' }), song('two', 'nd-record', 2, { ...record, title: 'Second' }),
  song('solo', 'nd-other', 1, { album: 'Another', artist: 'Aardvark', title: 'Morning light' }),
]
// What the music server lists for the same files, under its own IDs and with a title of its own.
const serverAlbums = [{ id: 'nd-record', name: 'Record (server)', artist: 'Band', songCount: 2 }, { id: 'nd-other', name: 'Another (server)', artist: 'Aardvark', songCount: 1 }]
const api = (overrides: Record<string, unknown> = {}) => ({
  getPlaylists: vi.fn(async () => ok({ playlists: { playlist: [{ id: 'pl', name: 'Mix', songCount: 1 }] } })),
  getPlaylist: vi.fn(async () => ok({ playlist: { entry: [{ id: 'song-nd-record-one', title: 'First', albumId: 'nd-record', album: 'Record (server)', artist: 'Band' }] } })),
  getAlbum: vi.fn(async () => ok({ album: { song: [{ id: 'song-nd-record-one', title: 'First', albumId: 'nd-record', album: 'Record (server)', artist: 'Band' }] } })),
  getAlbumList2: vi.fn(async () => ok({ albumList2: { album: serverAlbums } })),
  search3: vi.fn(async () => ok({ searchResult3: {} })),
  scrobble: vi.fn(async () => ok({})), ...overrides,
}) as unknown as SubsonicAPI
class TestAudio extends EventTarget {
  static made: TestAudio[] = []
  src = ''; paused = true; currentTime = 0; duration = 180; volume = 1
  constructor() { super(); TestAudio.made.push(this) }
  async play() { this.paused = false; this.dispatchEvent(new Event('play')) }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')) }
  load() {} removeAttribute() { this.src = '' }
}

let service: CatalogService, bridge: CatalogBridge, clock = T2
const listeners = new Set<() => void>()
const changed = () => { for (const listener of [...listeners]) listener() }
const scan = (files: ScanFile[], observedAt = T1) => service.ingestScan({ sourceId: 'folder-a', providerSourceId: 'navidrome', observedAt, rootAvailable: true, complete: true, files })
const install = (overrides: Partial<Bridge> = {}) => { window.musicCatalog = { ...bridge, onChange: callback => { listeners.add(callback); return () => { listeners.delete(callback) } }, ...overrides } }
const jobs = (queued: number) => { window.musicJobs = { reportPlayback() {}, status: async (): Promise<JobsStatus> => ({ mode: 'idle', classes: { hash: { queued, running: 0, done: 0, failed: 0 } } }), onChange: () => () => {} } }
const anchor = async (providerAlbumId: string) => (await bridge.albums()).albums[providerAlbumId].albumId
const tileOf = (title: string) => library.tiles.find(tile => tile.title === title)!
const propose = async (id: string, operations: Parameters<CatalogService['commitChangeSet']>[0]['operations']) =>
  service.commitChangeSet({ id, author: route, operations, evidence: [{ supports: true, sourceId: 'musicbrainz' }], baseVersion: (await service.listCatalogAlbums({})).version, committedAt: ++clock })
const settled = () => vi.waitFor(() => expect(catalogSearch.loading).toBe(false), { timeout: SEARCH_SETTLE * 3 })

beforeEach(async () => {
  vi.stubGlobal('Audio', TestAudio)
  TestAudio.made = []
  service = createFakeCatalogService()
  await service.registerSource({ id: 'folder-a', kind: 'local-folder', label: 'Music', evidenceClass: 'deterministic', licence: 'user', policy })
  await service.registerSource({ id: 'navidrome', kind: 'navidrome', label: 'Navidrome', evidenceClass: 'deterministic', licence: 'user', policy: { analysisAllowed: true, network: 'lan' } })
  await service.registerSource({ id: 'musicbrainz', kind: 'musicbrainz', label: 'MusicBrainz', evidenceClass: 'deterministic', licence: 'CC0-1.0', policy: { analysisAllowed: false, network: 'internet', consent: 'online-lookups' } })
  await scan(LIBRARY)
  clock = T2
  bridge = createCatalogBridge(service, { now: () => ++clock })
  session.api = api(); session.username = crypto.randomUUID(); session.base = 'http://localhost:1234'; session.authQs = 'u=me'
  library.tiles = []; library.revision = 0; library.details = undefined; library.mode = 'albums'
  player.queue = []; player.index = -1; player.order = 'normal'; player.collectionOperations = []; player.error = ''; player.view = ''; player.queueOpen = false
  setCatalogEnabled(true)
  loadCatalog()
  catalog.items = {}; catalog.estimated = {}; catalog.stats = {}; catalog.error = ''
})
afterEach(async () => {
  cleanup(); disposeCatalogSearch(); disposePlayback(); resetActivity()
  await new Promise(resolve => setTimeout(resolve, SAVE_DELAY))
  listeners.clear()
  delete window.musicCatalog; delete window.musicJobs
  session.api = null
  localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

describe('which catalog the window browses', () => {
  it('browses the library catalog through the bridge, with anchors as album IDs and the server links for covers', async () => {
    install(); jobs(0)
    await setMode('albums')
    expect([catalogSource.active, catalogSource.fallback]).toEqual(['virtual', ''])
    const recordId = await anchor('nd-record')
    // In the artist order the wall sorts by, with the titles the library holds, not the server's.
    expect(library.tiles.map(tile => [tile.title, tile.sub, tile.count])).toEqual([['Another', 'Aardvark', 1], ['Record', 'Band', 2]])
    const tile = tileOf('Record')
    expect([tile.id, tile.rawId, tile.aliases]).toEqual([`local:album:${recordId}`, recordId, ['local:album:nd-record']])
    expect(tile.cover).toBe('http://localhost:1234/rest/getCoverArt?id=al-nd-record&size=300&u=me')
    expect(session.api!.getAlbumList2).not.toHaveBeenCalled()
    // Playlists stay with the music server, also while albums come from the library.
    await setMode('playlists')
    expect(library.tiles.map(item => [item.id, item.title])).toEqual([['local:playlist:pl', 'Mix']])
    expect(catalogSource.active).toBe('virtual')
  })

  it('falls back to the music server without the bridge, with the setting off, while empty, while files are read and when the bridge fails', async () => {
    const served = () => library.tiles.map(tile => tile.id)
    const fromServer = ['local:album:nd-record', 'local:album:nd-other']
    // A browser or a phone: no bridge.
    await setMode('albums')
    expect([catalogSource.active, catalogSource.fallback, served()]).toEqual(['navidrome', 'unavailable', fromServer])
    // An older desktop build: the bridge without the read model.
    install({ catalogAlbums: undefined })
    await setMode('albums')
    expect([catalogSource.active, catalogSource.fallback, served()]).toEqual(['navidrome', 'unavailable', fromServer])
    // The first scan has not been read yet.
    install({ catalogAlbums: async () => ({ albums: [], total: 0, version: 0 }) })
    await setMode('albums')
    expect([catalogSource.active, catalogSource.fallback, served()]).toEqual(['navidrome', 'empty', fromServer])
    // Files are still being read: the library lists only some albums.
    install(); jobs(3)
    await setMode('albums')
    expect([catalogSource.active, catalogSource.fallback, served()]).toEqual(['navidrome', 'catching-up', fromServer])
    // The bridge answers the first question and then fails.
    jobs(0)
    const real = bridge.catalogAlbums
    install({ catalogAlbums: vi.fn(real).mockImplementationOnce(real).mockRejectedValueOnce(new Error('The library is closed')) })
    await setMode('albums')
    expect([catalogSource.active, catalogSource.fallback, served(), library.error]).toEqual(['navidrome', 'failed', fromServer, ''])
    install({ catalogAlbums: async () => { throw new Error('The library is closed') } })
    await setMode('albums')
    expect([catalogSource.active, catalogSource.fallback, served()]).toEqual(['navidrome', 'failed', fromServer])
    // The setting, last: the bridge works and is not asked.
    const asked = vi.fn(real)
    install({ catalogAlbums: asked })
    setCatalogEnabled(false)
    await setMode('albums')
    expect([catalogSource.active, catalogSource.fallback, served(), asked.mock.calls.length]).toEqual(['navidrome', 'off', fromServer, 0])
    setCatalogEnabled(true)
    await setMode('albums')
    expect(catalogSource.active).toBe('virtual')
  })

  it('keeps the albums on screen when a refresh of the library catalog fails, and does not swap catalogs', async () => {
    const real = bridge.catalogAlbums, pages = vi.fn(real)
    install({ catalogAlbums: pages }); jobs(0)
    await setMode('albums')
    const shown = library.tiles
    pages.mockRejectedValueOnce(new Error('The library is busy'))
    await setMode('albums', true)
    expect([library.tiles, catalogSource.active, library.error]).toEqual([shown, 'virtual', 'The library is busy'])
    expect(session.api!.getAlbumList2).not.toHaveBeenCalled()
    await setMode('albums', true)
    expect([library.tiles.map(tile => tile.id), library.error]).toEqual([shown.map(tile => tile.id), ''])
  })

  it('offers the choice in Settings on the desktop and loads the library again when it changes', async () => {
    install(); jobs(0)
    await setMode('albums')
    render(Settings, { coversOnly: false, motion: false, initialTab: 'advanced', onclose: () => {} })
    const box = () => [...document.querySelectorAll<HTMLLabelElement>('.catalog-choice label')].find(label => label.textContent?.includes('as Kept identified them'))!.querySelector('input')!
    expect([box().checked, document.querySelector('.catalog-choice [role=status]')?.textContent]).toEqual([true, 'In use.'])
    box().click()
    await vi.waitFor(() => expect(library.tiles.map(tile => tile.title)).toEqual(['Record (server)', 'Another (server)']))
    expect([catalogSource.active, localStorage.getItem('library.catalog'), document.querySelector('.catalog-choice [role=status]')?.textContent]).toEqual(['navidrome', 'navidrome', ''])
    box().click()
    await vi.waitFor(() => expect(library.tiles.map(tile => tile.title)).toEqual(['Another', 'Record']))
    expect(localStorage.getItem('library.catalog')).toBeNull()
  })
})

describe('browse, search and details on the same anchor', () => {
  it('agree on the title and the track list, also after a correction', async () => {
    install(); jobs(0)
    const recordId = await anchor('nd-record')
    await bridge.setField({ albumId: recordId, field: 'title', value: 'Record (Remastered)' })
    await setMode('albums')
    const tile = tileOf('Record (Remastered)')
    const tracks = await songsOf(tile)
    expect(tracks.map(track => [track.title, track.album, track.albumId])).toEqual([['First', 'Record (Remastered)', tile.id], ['Second', 'Record (Remastered)', tile.id]])
    // The album found by its new title is the very tile the wall shows.
    startCatalogSearch('remastered', 'all'); await settled()
    expect(catalogSearch.collections).toEqual([tile])
    // A track found by its title is the track of the album details, played from that album.
    startCatalogSearch('second', 'all'); await settled()
    const [found] = catalogSearch.tracks
    expect([found.id, found.rawId, found.album, found.cover, found.playbackOrigin]).toEqual([tracks[1].id, tracks[1].rawId, tracks[1].album, tracks[1].cover, tile])
    expect(catalogSearch.collections).toEqual([tile])
    // The artist found opens the same album.
    startCatalogSearch('band', 'all'); await settled()
    expect(catalogSearch.artists.map(item => item.title)).toEqual(['Band'])
    await pick(catalogSearch.artists[0])
    expect(library.tiles).toEqual([tile])
    // The details view lists the same tracks under the same title.
    render(CollectionDetails, { tile, onclose: () => {} })
    await vi.waitFor(() => expect([...document.querySelectorAll('.track-name')].map(row => row.textContent)).toEqual(['First', 'Second']))
    expect(document.querySelector('h1')?.textContent).toBe('Record (Remastered)')
  })

  it('loads more search results page by page and keeps the rows already shown in place', async () => {
    const PAGE = 50, TOTAL = 120
    await scan([...LIBRARY, ...Array.from({ length: TOTAL }, (_, index) => song(`t${index}`, 'nd-long', index + 1, { album: 'Long', artist: 'Band', title: `Take ${String(index).padStart(3, '0')}` }))], T2)
    const search = vi.fn(bridge.catalogSearch)
    install({ catalogSearch: search }); jobs(0)
    await setMode('albums')
    startCatalogSearch('take', 'all'); await settled()
    expect([catalogSearch.tracks.length, catalogSearch.moreLocal]).toEqual([PAGE, true])
    const first = catalogSearch.tracks.map(track => track.id)
    moreCatalogSearch(); await settled()
    expect(catalogSearch.tracks.map(track => track.id).slice(0, PAGE)).toEqual(first)
    expect(catalogSearch.tracks.length).toBe(PAGE * 2)
    // Only the kind with more to give is asked again.
    expect(search.mock.calls.at(-1)![0]).toEqual({ query: 'take', albums: undefined, artists: undefined, tracks: { offset: PAGE, limit: PAGE } })
    moreCatalogSearch(); await settled()
    expect([catalogSearch.tracks.length, catalogSearch.moreLocal, new Set(catalogSearch.tracks.map(track => track.id)).size]).toEqual([TOTAL, false, TOTAL])
  })

  it('plays a catalog track through its server link without asking the catalog at play time', async () => {
    const album = vi.fn(bridge.catalogAlbum)
    install({ catalogAlbum: album }); jobs(0)
    await setMode('albums')
    const tile = tileOf('Record'), tracks = await songsOf(tile)
    const asked = album.mock.calls.length
    expect(tracks.map(track => resolveTrackPlayback(track))).toEqual([{ kind: 'navidrome-stream', songId: 'song-nd-record-one' }, { kind: 'navidrome-stream', songId: 'song-nd-record-two' }])
    await pick(tile)
    await vi.waitFor(() => expect(player.playing).toBe(true))
    expect(player.song?.catalogRef).toEqual({ kind: 'asset', id: tracks[0].rawId })
    expect(TestAudio.made.some(audio => audio.src.includes('/rest/stream?id=song-nd-record-one&'))).toBe(true)
    expect(collectionPlayback(tile).current).toBe(true)
    // pick listed the album once more; starting the track asked nothing further.
    expect(album.mock.calls.length).toBe(asked + 1)
  })

  it('answers to the server ID of an album: playing from a playlist lights the catalog tile, and its plays count', async () => {
    install(); jobs(0)
    await setMode('albums')
    const tile = tileOf('Record')
    expect([tileIdOf('local:album:nd-record'), tileIdOf('local:album:unknown'), tileIdOf(undefined)]).toEqual([tile.id, 'local:album:unknown', undefined])
    player.queue = [{ id: 'local:track:song-nd-record-one', rawId: 'song-nd-record-one', source: 'local', title: 'First', albumId: 'local:album:nd-record', cover: '', available: true }]; player.index = 0
    expect(collectionPlayback(tile).current).toBe(true)
    expect(collectionPlayback(tileOf('Another')).current).toBe(false)
    catalog.stats = { 'local:album:nd-record': { plays: 3, lastPlayed: T1 }, [tile.id]: { plays: 2, lastPlayed: T2 } }
    expect([albumPlays(tile), albumPlays(tileOf('Another'))]).toEqual([5, 0])
  })

  it('keeps hand-set tags and favourites on the anchor, and shows the genre and year of the catalog', async () => {
    install(); jobs(0)
    await setMode('albums')
    const tile = tileOf('Record'), recordId = tile.rawId
    saveMetadata(tile.id, { favorite: true, traits: { energy: 80 } })
    await vi.waitFor(async () => expect((await bridge.catalogAlbum({ albumId: recordId })).album).toMatchObject({ favorite: true, traits: { energy: { value: 80, provenance: 'hand-set' } } }))
    // The same decisions show under the server's ID, for when the app falls back to its list.
    catalog.items = {}
    await syncDecisions()
    expect([catalog.items[tile.id], catalog.items['local:album:nd-record']]).toEqual([{ favorite: true, traits: { energy: 80 }, colorReady: false }, { favorite: true, traits: { energy: 80 }, colorReady: false }])
    // A genre typed on this device long ago does not hide what the catalog says, and fills in where it says nothing.
    catalog.items['local:album:nd-record'] = { genres: ['Typed'], year: 1901 }
    catalog.items['local:album:nd-other'] = { genres: ['Typed'], year: 1901 }
    expect([metadata(tile).genres, metadata(tile).year, metadata(tileOf('Another')).genres, metadata(tileOf('Another')).year]).toEqual([['Rock'], 1999, ['Typed'], 1901])
  })

  it('learns how tracks kept from an earlier run play before one is played', async () => {
    install(); jobs(0)
    const { album } = await bridge.catalogAlbum({ albumId: await anchor('nd-other') })
    const kept = { id: 'local:track:x', rawId: album!.tracks[0].assetId, source: 'local' as const, title: 'Morning light', cover: '', available: true, catalogRef: { kind: 'asset' as const, id: album!.tracks[0].assetId } }
    expect(resolveTrackPlayback(kept)).toBeUndefined()
    await primePlayback([kept, { ...kept, catalogRef: { kind: 'asset', id: 'asset:gone' } }])
    expect(resolveTrackPlayback(kept)).toEqual({ kind: 'navidrome-stream', songId: 'song-nd-other-solo' })
  })
})

describe('priming playback', () => {
  it('reports failure so a caller can keep entries unavailable', async () => {
    install({ playbackLinks: async () => { throw new Error('bridge down') } }); jobs(0)
    const id = 'asset:never-seen'
    const kept = { id: 'local:track:y', rawId: id, source: 'local' as const, title: 'Morning light', cover: '', available: true, catalogRef: { kind: 'asset' as const, id } }
    expect(await primePlayback([kept])).toBe(false)
    expect(resolveTrackPlayback(kept)).toBeUndefined()
  })
})

describe('responses that arrive late', () => {
  it('ignores a library page superseded by a newer load', async () => {
    const real = bridge.catalogAlbums, gate = deferred<void>()
    let held = true
    install({ catalogAlbums: async request => { const page = await real(request); if (held && request?.limit !== 1) { held = false; await gate.promise; return { ...page, albums: page.albums.map(album => ({ ...album, title: 'Stale' })) } } return page } }); jobs(0)
    const first = setMode('albums')
    await vi.waitFor(() => expect(held).toBe(false))
    await setMode('albums')
    const shown = library.tiles.map(tile => tile.title)
    gate.resolve(); await first; await tick()
    expect(library.tiles.map(tile => tile.title)).toEqual(shown)
    expect(shown).toEqual(['Another', 'Record'])
  })

  it('ignores search results for a query the user has moved on from', async () => {
    const real = bridge.catalogSearch, gate = deferred<void>()
    install({ catalogSearch: async request => { if (request.query === 'record') await gate.promise; return real(request) } }); jobs(0)
    await setMode('playlists')
    startCatalogSearch('record', 'all')
    await new Promise(resolve => setTimeout(resolve, SEARCH_SETTLE))
    startCatalogSearch('another', 'all'); await settled()
    const shown = catalogSearch.collections.map(tile => tile.title)
    gate.resolve(); await new Promise(resolve => setTimeout(resolve, SAVE_DELAY))
    expect([catalogSearch.collections.map(tile => tile.title), shown]).toEqual([['Another'], ['Another']])
  })

  it('ignores the review of an album the details view has left', async () => {
    const real = bridge.albumReview, gate = deferred<void>(), recordId = await anchor('nd-record'), otherId = await anchor('nd-other')
    install({ albumReview: async request => { if (request.albumId === recordId) await gate.promise; return real(request) } })
    const view = render(AlbumReview, { albumId: recordId, title: 'Record' })
    await view.rerender({ albumId: otherId, title: 'Another' })
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('#review-title')?.value).toBe('Another'))
    gate.resolve(); await new Promise(resolve => setTimeout(resolve, SAVE_DELAY))
    expect(document.querySelector<HTMLInputElement>('#review-title')?.value).toBe('Another')
  })
})

describe('a change in the library while the wall is open', () => {
  it('replaces albums in place: the order, the scroll position and the focused tile stay, new albums are appended', async () => {
    const many = Array.from({ length: MANY_ALBUMS }, (_, index) => song('a', `nd-${String(index).padStart(2, '0')}`, 1, { album: `Album ${String(index).padStart(2, '0')}`, artist: `Artist ${String(index).padStart(2, '0')}`, title: 'Song' }))
    await scan(many, T2)
    install(); jobs(0)
    const stop = watchCatalog()
    await setMode('albums')
    const view = render(Grid, { tiles: library.tiles, onpick: () => {}, hidden: false }); await tick()
    const scroller = document.querySelector<HTMLElement>('.scroll')!
    const order = () => library.tiles.map(tile => tile.id)
    const before = order(), revision = library.revision
    scroller.scrollTop = 600; scroller.dispatchEvent(new Event('scroll')); await tick()
    const top = scroller.scrollTop
    expect(top).toBeGreaterThan(0)
    const focused = [...document.querySelectorAll<HTMLButtonElement>('.tile')].find(button => { const box = button.getBoundingClientRect(); return box.top > 0 && box.bottom < innerHeight })!
    focused.focus({ preventScroll: true })
    const focusedId = focused.dataset.collectionId!, wall = () => [...document.querySelectorAll<HTMLElement>('.tile')].map(button => button.dataset.collectionId)
    const shownBefore = wall()
    // A repair renames an artist so that it would sort first, and a scan brings a new album that would sort first too.
    const renamed = await anchor('nd-30')
    await propose('repair-1', [{ kind: 'set-field', subject: { kind: 'album', id: renamed }, field: 'artist', value: 'AAA First' }])
    await scan([...many, song('new', 'nd-new', 1, { album: 'Newcomer', artist: 'AAA Newest', title: 'Song' })], T2 + 1)
    changed(); changed()
    await vi.waitFor(() => expect(library.revision).toBeGreaterThan(revision), REFRESH_WAIT)
    await view.rerender({ tiles: library.tiles }); await tick()
    const newcomer = tileOf('Newcomer')
    expect(order()).toEqual([...before, newcomer.id])
    expect(library.tiles.find(tile => tile.rawId === renamed)?.sub).toBe('AAA First')
    expect(wall()).toEqual(shownBefore)
    expect(scroller.scrollTop).toBe(top)
    expect((document.activeElement as HTMLElement).dataset.collectionId).toBe(focusedId)
    // Changes that arrive together were one refresh.
    expect(library.revision).toBe(revision + 1)
    stop()
  })

  it('refreshes the open album in place when a repair renames a track, and leaves the server catalog alone', async () => {
    install(); jobs(0)
    const stop = watchCatalog()
    await setMode('albums')
    const tile = tileOf('Record')
    render(CollectionDetails, { tile, onclose: () => {} })
    await vi.waitFor(() => expect([...document.querySelectorAll('.track-name')].map(row => row.textContent)).toEqual(['First', 'Second']))
    const row = document.querySelector<HTMLButtonElement>('.track-row .track')!
    row.focus()
    const { album } = await bridge.catalogAlbum({ albumId: tile.rawId })
    await propose('repair-2', [{ kind: 'set-field', subject: { kind: 'asset', id: album!.tracks[1].assetId }, field: 'title', value: 'Second (live)' }])
    changed()
    await vi.waitFor(() => expect([...document.querySelectorAll('.track-name')].map(item => item.textContent)).toEqual(['First', 'Second (live)']))
    expect(document.activeElement).toBe(row)
    stop()
    // While the music server's list is browsed, a change in the library reloads nothing.
    setCatalogEnabled(false)
    await setMode('albums')
    const stopServer = watchCatalog(), revision = library.revision
    changed()
    await new Promise(resolve => setTimeout(resolve, SEARCH_SETTLE))
    expect(library.revision).toBe(revision)
    stopServer()
  })
})

describe('reviewing an album', () => {
  const field = (name: string) => document.querySelector<HTMLElement>(`.field[data-field=${name}]`)!
  const input = (name: string) => field(name).querySelector('input')!
  const button = (name: string, label: string) => [...field(name).querySelectorAll('button')].find(item => item.textContent === label)!
  const origin = (name: string) => [field(name).dataset.origin, field(name).querySelector('.origin')?.textContent]
  const note = () => document.querySelector('.note')?.textContent
  const type = (name: string, value: string) => { input(name).focus(); input(name).value = value; input(name).dispatchEvent(new Event('input', { bubbles: true })) }

  it('shows where each field comes from, saves a correction as the user and undoes it field by field', async () => {
    install()
    const recordId = await anchor('nd-record')
    render(AlbumReview, { albumId: recordId, title: 'Record' })
    await vi.waitFor(() => expect(input('title').value).toBe('Record'))
    expect([origin('title'), origin('year'), input('year').value, input('genre').value]).toEqual([['tags', 'From the file tags'], ['tags', 'From the file tags'], '1999', 'Rock'])
    expect(button('title', 'Undo').disabled).toBe(true)
    // A route repairs the title: it shows as Kept's change, with an undo.
    await propose('repair-1', [{ kind: 'set-field', subject: { kind: 'album', id: recordId }, field: 'title', value: 'Record (Deluxe)' }])
    changed()
    await vi.waitFor(() => expect(input('title').value).toBe('Record (Deluxe)'))
    expect([origin('title'), button('title', 'Undo').disabled]).toEqual([['route', 'Changed by Kept (route-release)'], false])
    // The user corrects it: shown as theirs at once, stored as a change of their own.
    type('title', 'Record (Mine)')
    input('title').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await vi.waitFor(() => expect(origin('title')).toEqual(['user', 'Set by you']))
    expect((await bridge.catalogAlbum({ albumId: recordId })).album?.title).toBe('Record (Mine)')
    expect(note()).toBe('Title saved. Undo brings back what was there.')
    // Undo, field by field: first the user's value, then Kept's, and then nothing is left to undo.
    button('title', 'Undo').click()
    await vi.waitFor(() => expect([input('title').value, origin('title')[0]]).toEqual(['Record (Deluxe)', 'route']))
    button('title', 'Undo').focus(); button('title', 'Undo').click()
    await vi.waitFor(() => expect([input('title').value, origin('title')[0]]).toEqual(['Record', 'tags']))
    await vi.waitFor(() => expect(button('title', 'Undo').disabled).toBe(true))
    // Focus did not fall out of the row when its button was disabled.
    await vi.waitFor(() => expect(document.activeElement).toBe(input('title')))
    expect((await bridge.activity()).entries.map(entry => [entry.actor, entry.undone])).toEqual([['you', true], ['kept', true]])
    // The year is checked before anything is sent.
    type('year', 'ninety'); input('year').dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(note()).toBe('A year is a number, such as 1971.'))
    expect((await bridge.catalogAlbum({ albumId: recordId })).album?.year).toBe(1999)
    input('year').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await vi.waitFor(() => expect(input('year').value).toBe('1999'))
  })

  it('locks a field against Kept, keeps it open to the user, and unlocks it', async () => {
    install()
    const recordId = await anchor('nd-record')
    render(AlbumReview, { albumId: recordId, title: 'Record' })
    await vi.waitFor(() => expect(input('artist').value).toBe('Band'))
    button('artist', 'Lock').click()
    // Pressed on the same frame, confirmed by the library after.
    await tick()
    expect(field('artist').querySelector('.lock')?.getAttribute('aria-pressed')).toBe('true')
    await vi.waitFor(() => expect(note()).toBe('Kept will not change the artist of this album.'))
    expect((await bridge.catalogAlbum({ albumId: recordId })).album?.locks).toEqual(['artist'])
    expect((await propose('repair-1', [{ kind: 'set-field', subject: { kind: 'album', id: recordId }, field: 'artist', value: 'The Band' }])).status).toBe('rejected')
    type('artist', 'Band & Friends'); input('artist').dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(origin('artist')).toEqual(['user', 'Set by you']))
    button('artist', 'Locked').click()
    await vi.waitFor(() => expect(note()).toBe('Kept may change the artist of this album again.'))
    expect((await bridge.catalogAlbum({ albumId: recordId })).album?.locks).toEqual([])
    expect((await propose('repair-2', [{ kind: 'set-field', subject: { kind: 'album', id: recordId }, field: 'artist', value: 'The Band' }])).status).toBe('applied')
  })

  it('puts a lock back and says so when the library refuses, and keeps what is typed through a background update', async () => {
    const recordId = await anchor('nd-record')
    install({ lockField: async () => { throw new Error('The library is closed') } })
    render(AlbumReview, { albumId: recordId, title: 'Record' })
    await vi.waitFor(() => expect(input('title').value).toBe('Record'))
    button('title', 'Lock').click()
    await vi.waitFor(() => expect(note()).toBe('That could not be saved. Nothing was changed.'))
    expect(field('title').querySelector('.lock')?.getAttribute('aria-pressed')).toBe('false')
    type('genre', 'Roc')
    await propose('repair-1', [{ kind: 'set-field', subject: { kind: 'album', id: recordId }, field: 'title', value: 'Record (Deluxe)' }])
    changed()
    await vi.waitFor(() => expect(input('title').value).toBe('Record (Deluxe)'))
    expect([input('genre').value, document.activeElement]).toEqual(['Roc', input('genre')])
  })

  it('opens from the album menu for a catalog album only, and closes with Escape before the album does', async () => {
    install(); jobs(0)
    await setMode('albums')
    const close = vi.fn()
    const view = render(CollectionDetails, { tile: tileOf('Record'), onclose: close })
    const openMenu = async () => { document.querySelector<HTMLButtonElement>('[aria-label="Album menu"]')!.click(); await tick() }
    const item = () => [...document.querySelectorAll<HTMLButtonElement>('#album-actions button')].find(entry => entry.textContent === 'Album details & changes')
    await openMenu()
    item()!.click()
    await vi.waitFor(() => expect(input('title').value).toBe('Record'))
    expect(document.activeElement).toBe(document.querySelector('[aria-label="Album menu"]'))
    document.querySelector('#album-view')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await tick()
    expect([document.querySelector('.review'), close.mock.calls.length]).toEqual([null, 0])
    await view.unmount()
    // An album of the music server's own list has nothing to review.
    render(CollectionDetails, { tile: { id: 'local:album:nd-record', rawId: 'nd-record', source: 'local', kind: 'album', title: 'Record (server)', sub: 'Band', cover: '', count: 1, available: true }, onclose: close })
    await openMenu()
    expect(item()).toBeUndefined()
  })
})

describe('the activity list', () => {
  const rows = () => [...document.querySelectorAll('.activity ol > li')]
  const compared = (row: Element) => [...row.querySelectorAll('.compare li')].map(item => [item.querySelector('.what')?.textContent, item.querySelector('.before')?.textContent, item.querySelector('.after')?.textContent, item.classList.contains('undone')])

  it('compares what a route changed, before and after, and undoes one operation or all of them', async () => {
    install()
    const recordId = await anchor('nd-record'), otherId = await anchor('nd-other')
    await bridge.setFavorite({ albumId: recordId, value: true })
    await propose('repair-1', [
      { kind: 'set-field', subject: { kind: 'album', id: recordId }, field: 'title', value: 'Record (Deluxe)' },
      { kind: 'set-field', subject: { kind: 'album', id: otherId }, field: 'year', value: 1971 },
    ])
    await loadActivity()
    const view = render(ActivityPanel, { entries: activity.entries, onundo: (id: string, operation?: number) => void undoActivity(id, operation) })
    const [kept, mine] = rows()
    expect(kept.querySelector('.meta')?.textContent).toContain('Kept (route-release)')
    expect(compared(kept)).toEqual([['Title', 'was Record', 'now Record (Deluxe)', false], ['Year', 'was not set', 'now 1971', false]])
    // A change the user made is a receipt with an undo, without a comparison.
    expect([mine.querySelector('.meta')?.textContent?.startsWith('You'), mine.querySelector('.compare')]).toEqual([true, null])
    expect(kept.querySelector(':scope > [data-slot=button]')?.textContent).toBe('Undo all')
    // One operation: the year goes back, the title stays.
    const partBox = kept.querySelectorAll<HTMLElement>('.compare [data-slot=button]')[1].getBoundingClientRect()
    kept.querySelectorAll<HTMLButtonElement>('.compare [data-slot=button]')[1].click()
    await vi.waitFor(async () => expect((await bridge.catalogAlbum({ albumId: otherId })).album?.year).toBeUndefined())
    await vi.waitFor(() => expect(activity.entries[0].operations?.map(item => item.undone)).toEqual([false, true]))
    await view.rerender({ entries: activity.entries })
    expect(compared(rows()[0]).map(item => item[3])).toEqual([false, true])
    // "Undone" takes the box of the button it replaced, so the row does not move.
    const stateBox = rows()[0].querySelector<HTMLElement>('.compare .state')!.getBoundingClientRect()
    expect([stateBox.width, stateBox.height, stateBox.left]).toEqual([partBox.width, partBox.height, partBox.left])
    expect((await bridge.catalogAlbum({ albumId: recordId })).album?.title).toBe('Record (Deluxe)')
    // All of it: the entry is struck through, and Kept is told not to make the change again.
    rows()[0].querySelector<HTMLButtonElement>(':scope > [data-slot=button]')!.click()
    await vi.waitFor(async () => expect((await bridge.catalogAlbum({ albumId: recordId })).album?.title).toBe('Record'))
    await vi.waitFor(() => expect(activity.entries[0]).toMatchObject({ undone: true, detail: 'Kept will not make this change again.' }))
    await view.rerender({ entries: activity.entries })
    expect([rows()[0].classList.contains('undone'), rows()[0].querySelector(':scope > .state')?.textContent, rows()[0].querySelectorAll('.compare [data-slot=button]').length]).toEqual([true, 'Undone', 0])
  })

  it('puts an operation back and says why when the library refuses to undo it', async () => {
    install({ undo: async () => ({ status: 'blocked', reason: 'changed-since', blockedBy: [] }) })
    const recordId = await anchor('nd-record'), otherId = await anchor('nd-other')
    await propose('repair-1', [
      { kind: 'set-field', subject: { kind: 'album', id: recordId }, field: 'title', value: 'Record (Deluxe)' },
      { kind: 'set-field', subject: { kind: 'album', id: otherId }, field: 'year', value: 1971 },
    ])
    await loadActivity()
    await undoActivity('repair-1', 0)
    expect([activity.entries[0].operations?.map(item => item.undone), activity.error]).toEqual([[false, false], 'This was changed again since, so it was left as it is.'])
  })
})

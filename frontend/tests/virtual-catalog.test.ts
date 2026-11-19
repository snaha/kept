import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CatalogDatabase } from '../../desktop/catalog-database.js'
import { createFakeCatalogService } from '../../shared/catalog-fake.js'
import { createCatalogBridge } from '../../shared/catalog-bridge.js'
import { createVirtualCatalog, isVirtualCollection } from '../src/lib/virtual-catalog.ts'
import { createPlaybackResolver, trackCatalogRef } from '../src/lib/playback-ref.ts'
import type { Collection, Track } from '../src/lib/music.ts'

const SIZE = 4096
const T = 1000
const COVER_SIZE = 300
const policy = { analysisAllowed: true, network: 'none' as const }
const folder = { id: 'folder', kind: 'local-folder' as const, label: 'Music', evidenceClass: 'deterministic' as const, licence: 'user' as const, policy }
const navidrome = { id: 'navidrome', kind: 'navidrome' as const, label: 'Navidrome', evidenceClass: 'deterministic' as const, licence: 'user' as const, policy: { ...policy, network: 'lan' as const } }
const record = { album: 'Record', albumArtist: 'Band', artist: 'Band', year: 1999, genre: 'Rock' }
const guest = 'Vemrul Quenavosk'
const file = (name: string, albumId: string, track: number, tags: object) => ({ path: `${albumId}/${name}.flac`, contentHash: `hash-${name}`, size: SIZE, track, providerTrackId: `song-${name}`, providerAlbumId: albumId, tags })
const cover = (id: string | undefined, size = COVER_SIZE) => (id ? `cover:${id}:${size}` : '')
const search = { query: '', albumCount: 50, albumOffset: 0, artistCount: 50, artistOffset: 0, songCount: 50, songOffset: 0 }

async function seed(service = createFakeCatalogService()) {
  await service.registerSource(folder)
  await service.registerSource(navidrome)
  const scan = (files: object[], observedAt = T, rootAvailable = true) => service.ingestScan({ sourceId: folder.id, providerSourceId: navidrome.id, observedAt, rootAvailable, complete: rootAvailable, files } as Parameters<typeof service.ingestScan>[0])
  const result = await scan([
    file('one', 'nd-record', 1, { ...record, title: 'First' }), file('two', 'nd-record', 2, { ...record, title: 'Second', artist: guest }),
    file('solo', 'nd-other', 1, { album: 'Another', artist: 'Aardvark', title: 'First light' }),
  ])
  const resolver = createPlaybackResolver()
  const provider = createVirtualCatalog({ resolver, playbackSourceId: 'navidrome', cover })
  const [recordId, otherId] = result.albumIds
  return { service, bridge: createCatalogBridge(service), provider, resolver, scan, recordId, otherId, assetIds: result.assetIds }
}
const tracksOf = async (provider: ReturnType<typeof createVirtualCatalog>, bridge: Parameters<typeof provider.tracks>[0], collection: Collection) => (await Array.fromAsync(provider.tracks(bridge, collection))).flat()

test('lists albums in the artist order with covers, aliases and the fields browse filters on', async () => {
  const { bridge, provider, recordId, otherId } = await seed()
  const tiles = (await Array.fromAsync(provider.albums(bridge, 'alphabeticalByArtist'))).flat()
  assert.deepEqual(tiles.map(tile => [tile.id, tile.title, tile.sub, tile.count, tile.year, tile.genres, tile.cover, tile.aliases]), [
    [`local:album:${otherId}`, 'Another', 'Aardvark', 1, undefined, [], `cover:al-nd-other:${COVER_SIZE}`, ['local:album:nd-other']],
    [`local:album:${recordId}`, 'Record', 'Band', 2, 1999, ['Rock'], `cover:al-nd-record:${COVER_SIZE}`, ['local:album:nd-record']],
  ])
  assert.ok(tiles.every(tile => tile.available && isVirtualCollection(tile) && tile.addedAt === new Date(T).toISOString()))
  assert.equal(isVirtualCollection({ kind: 'album', rawId: 'nd-record' }), false)
  assert.equal(isVirtualCollection({ kind: 'playlist', rawId: 'album:1' }), false)
})

test('maps tracks to occurrences of assets and registers how each one plays as it is handed out', async () => {
  const { bridge, provider, resolver, recordId, assetIds } = await seed()
  const [, collection] = (await Array.fromAsync(provider.albums(bridge, 'alphabeticalByArtist'))).flat()
  const tracks = await tracksOf(provider, bridge, collection)
  assert.deepEqual(tracks.map(track => [track.title, track.artist, track.album, track.albumId, track.track, track.playbackOriginIndex, track.available]), [
    ['First', 'Band', 'Record', `local:album:${recordId}`, 1, 0, true], ['Second', guest, 'Record', `local:album:${recordId}`, 2, 1, true],
  ])
  assert.deepEqual(tracks[0].catalogRef, { kind: 'asset', id: assetIds[0] })
  assert.notEqual(tracks[0].id, tracks[0].rawId, 'occurrence id and asset id stay distinct')
  assert.equal(tracks[0].cover, 'cover:al-nd-record:512')
  assert.deepEqual(resolver.resolve(trackCatalogRef(tracks[0])), { kind: 'navidrome-stream', songId: 'song-one' })
  assert.deepEqual(resolver.resolve(trackCatalogRef(tracks[1])), { kind: 'navidrome-stream', songId: 'song-two' })
})

test('search, details and browse agree on the same anchor', async () => {
  const { bridge, provider, recordId } = await seed()
  await bridge.setField({ albumId: recordId, field: 'title', value: 'Record (Remastered)' })
  const browsed = (await Array.fromAsync(provider.albums(bridge, 'alphabeticalByArtist'))).flat().find(tile => tile.rawId === recordId)!
  const found = await provider.search(bridge, { ...search, query: 'remastered' })
  assert.deepEqual(found.collections, [browsed])
  const details = await tracksOf(provider, bridge, browsed)
  const byTrack = await provider.search(bridge, { ...search, query: 'second', albumCount: 0 })
  assert.deepEqual(byTrack.related, [browsed])
  assert.deepEqual(byTrack.tracks.map(({ playbackOriginIndex, ...track }) => track), details.filter(track => track.title === 'Second').map(({ playbackOriginIndex, ...track }) => track))
  assert.deepEqual(details.map(track => track.album), ['Record (Remastered)', 'Record (Remastered)'])
  // The artist found opens the same album.
  const artists = (await provider.search(bridge, { ...search, query: 'band' })).artists
  assert.deepEqual(artists.map(item => [item.id, item.title, item.count, isVirtualCollection(item)]), [['local:artist:Band', 'Band', 1, true]])
  assert.deepEqual(await provider.artistAlbums(bridge, artists[0].rawId), [browsed])
})

test('opening a track artist requests their credited albums from the bridge', async () => {
  const { bridge, provider, recordId } = await seed()
  const { artists: [artist] } = await provider.search(bridge, { ...search, query: guest })
  const requests: Parameters<typeof bridge.catalogAlbums>[0][] = []
  const client = {
    ...bridge,
    catalogAlbums: (request: Parameters<typeof bridge.catalogAlbums>[0]) => {
      requests.push(request)
      return bridge.catalogAlbums(request)
    },
  }
  const albums = await provider.artistAlbums(client, artist.rawId)
  assert.equal(artist.count, 1)
  assert.deepEqual(albums.map(album => album.rawId), [recordId])
  assert.deepEqual(requests.map(request => request?.artist), [guest])
})

test('search pages each kind on its own and skips a kind that asks for nothing', async () => {
  const { bridge, provider } = await seed()
  const first = await provider.search(bridge, { ...search, query: 'first', songCount: 1 })
  const second = await provider.search(bridge, { ...search, query: 'first', songCount: 1, songOffset: 1, albumCount: 0, artistCount: 0 })
  assert.deepEqual([first.tracks.map(track => track.title), second.tracks.map(track => track.title)], [['First'], ['First light']])
  assert.deepEqual([second.collections, second.artists], [[], []])
  assert.deepEqual((await provider.search(bridge, { ...search, query: 'first', songOffset: 2 })).tracks, [])
})

test('an offline folder keeps its albums listed and unplayable, and a re-ID keeps the anchor and moves the cover', async () => {
  const { bridge, provider, resolver, scan, recordId } = await seed()
  const tiles = async () => (await Array.fromAsync(provider.albums(bridge, 'alphabeticalByArtist'))).flat()
  await scan([file('one', 'nd-record-2', 1, { ...record, title: 'First' }), file('two', 'nd-record-2', 2, { ...record, title: 'Second' }), file('solo', 'nd-other', 1, { album: 'Another', artist: 'Aardvark', title: 'First light' })], T + 1)
  const renamed = (await tiles()).find(tile => tile.rawId === recordId)!
  assert.deepEqual([renamed.cover, renamed.aliases], [`cover:al-nd-record-2:${COVER_SIZE}`, ['local:album:nd-record-2', 'local:album:nd-record']])
  await scan([], T + 2, false)
  const offline = await tiles()
  assert.deepEqual(offline.map(tile => tile.available), [false, false])
  const tracks = await tracksOf(provider, bridge, offline[1])
  assert.ok(tracks.length === 2 && tracks.every(track => !track.available))
  assert.equal(resolver.resolve({ kind: 'asset', id: 'asset:none' }), undefined)
})

test('a legacy track resolves to itself and an unknown asset does not resolve', () => {
  const resolver = createPlaybackResolver()
  const legacy: Track = { id: 'local:track:9', rawId: '9', source: 'local', title: 'Old', cover: '', available: true }
  assert.deepEqual(trackCatalogRef(legacy), { kind: 'navidrome', id: '9' })
  assert.deepEqual(resolver.resolve(trackCatalogRef(legacy)), { kind: 'navidrome-stream', songId: '9' })
  assert.equal(resolver.resolve({ kind: 'asset', id: 'asset:none' }), undefined)
  resolver.update({ kind: 'asset', id: 'a' }, { kind: 'navidrome-stream', songId: 's' }, 1)
  resolver.update({ kind: 'asset', id: 'a' }, undefined, 2)
  assert.equal(resolver.resolve({ kind: 'asset', id: 'a' }), undefined)
})

test('late search cannot erase a newer stream or restore an offline one', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'kept-streams-'))
  const database = new CatalogDatabase(path.join(directory, 'library.sqlite'))
  t.after(async () => {
    await database.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const { bridge, provider, resolver, scan, otherId } = await seed(database.service)
  const { album } = await bridge.catalogAlbum({ albumId: otherId })
  const collection = provider.album(album!)
  const [track] = await tracksOf(provider, bridge, collection)
  const ref = trackCatalogRef(track)
  const solo = file('solo', 'nd-other', 1, { title: 'First light' })
  const holdSearch = async () => {
    const read = Promise.withResolvers<void>()
    const held = Promise.withResolvers<void>()
    const pending = provider.search({
      ...bridge,
      async catalogSearch(request) {
        const result = await bridge.catalogSearch(request)
        read.resolve()
        await held.promise
        return result
      },
    }, { ...search, query: 'light' })
    await Promise.race([pending, read.promise])
    return async () => { held.resolve(); await pending }
  }
  await scan([], T + 1, false)
  const releaseOffline = await holdSearch()
  const currentId = 'nd-returned'
  await scan([{ ...solo, providerTrackId: currentId }], T + 2)
  await tracksOf(provider, bridge, collection)
  await releaseOffline()
  assert.deepEqual(resolver.resolve(ref), { kind: 'navidrome-stream', songId: currentId })

  const releaseOnline = await holdSearch()
  await scan([], T + 3, false)
  await tracksOf(provider, bridge, collection)
  await releaseOnline()
  assert.equal(resolver.resolve(ref), undefined)
})

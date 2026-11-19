import assert from 'node:assert/strict'
import test from 'node:test'
import { createCatalogBridge, validateCatalogBridgeRequest } from '../shared/catalog-bridge.js'
import { createFakeCatalogService } from '../shared/catalog-fake.js'

const T1 = 1000, T2 = 2000
const SIZE = 4096, YEAR = 1959, OTHER_YEAR = 1997
const policy = { analysisAllowed: true, network: 'none' }
const folder = { id: 'folder-a', kind: 'local-folder', label: 'Music', evidenceClass: 'deterministic', licence: 'user', policy }
const navidrome = { id: 'navidrome', kind: 'navidrome', label: 'Navidrome', evidenceClass: 'deterministic', licence: 'user', policy: { ...policy, network: 'lan' } }
const musicbrainz = { id: 'musicbrainz', kind: 'musicbrainz', label: 'MusicBrainz', evidenceClass: 'deterministic', licence: 'CC0-1.0', policy: { analysisAllowed: false, network: 'internet', consent: 'online-lookups' } }
const route = { kind: 'route', id: 'route-release' }
const blue = { album: 'Kind of Blue', albumArtist: 'Miles Davis', artist: 'Miles Davis', year: YEAR, genre: 'Jazz' }
const file = (name, albumId, track, tags) => ({ path: `${albumId}/${name}.flac`, contentHash: `hash-${name}`, size: SIZE, track, providerTrackId: `song-${name}`, providerAlbumId: albumId, tags })

async function library() {
  const service = createFakeCatalogService()
  let clock = T2
  const bridge = createCatalogBridge(service, { now: () => ++clock })
  for (const source of [folder, navidrome, musicbrainz]) await service.registerSource(source)
  const { albumIds: [blueId, aguasId] } = await service.ingestScan({
    sourceId: folder.id, providerSourceId: navidrome.id, observedAt: T1, rootAvailable: true, complete: true, files: [
      file('so-what', 'nd-blue', 1, { ...blue, title: 'So What' }), file('all-blues', 'nd-blue', 2, { ...blue, title: 'All Blues' }),
      file('aguas', 'nd-aguas', 1, { album: 'Águas de Março', artist: 'Elis Regina', title: 'Águas de Março' }),
    ],
  })
  const version = async () => (await service.listCatalogAlbums({})).version
  const propose = async (id, operations) => service.commitChangeSet({ id, author: route, operations, evidence: [{ supports: true, sourceId: musicbrainz.id }], baseVersion: await version(), committedAt: ++clock })
  return { service, bridge, blueId, aguasId, propose }
}
const field = (review, name) => review.fields.find(item => item.field === name)

test('the window browses, opens and searches the projection, with the provider IDs it needs for covers and streams', async () => {
  const { bridge, blueId, aguasId } = await library()
  const page = await bridge.catalogAlbums({ sort: 'artist' })
  assert.deepEqual(page.albums.map(album => [album.id, album.title, album.links[0].externalId, album.genre]), [[aguasId, 'Águas de Março', 'nd-aguas', undefined], [blueId, 'Kind of Blue', 'nd-blue', 'Jazz']])
  const { album, version } = await bridge.catalogAlbum({ albumId: blueId })
  assert.deepEqual(album.tracks.map(track => [track.title, track.links[0].externalId]), [['So What', 'song-so-what'], ['All Blues', 'song-all-blues']])
  // Each kind pages on its own, and a track brings the album it belongs to.
  const found = await bridge.catalogSearch({ query: 'blues', albums: { offset: 0, limit: 5 }, tracks: { offset: 0, limit: 5 } })
  assert.deepEqual([found.albums, found.tracks.map(track => track.title), found.trackAlbums.map(item => item.id)], [[], ['All Blues'], [blueId]])
  assert.equal(found.trackAlbums[0].tracks, undefined)
  assert.deepEqual((await bridge.catalogSearch({ query: 'blue', tracks: { offset: 1, limit: 5 } })).tracks, [])
  assert.deepEqual((await bridge.catalogSearch({ query: 'blue', albums: { offset: 0, limit: 5 } })).albums.map(item => item.id), [blueId])
  const assetId = album.tracks[0].assetId
  assert.deepEqual(await bridge.playbackLinks({ assetIds: [assetId, 'asset-none'] }), {
    links: { [assetId]: album.tracks[0].links, 'asset-none': [] }, version,
  })
  // The decisions keyed by the provider's ID come from the same rows.
  assert.equal((await bridge.albums()).albums['nd-blue'].albumId, blueId)
})

test('a field shows who set it, and a correction, a lock and an undo each change that', async () => {
  const { bridge, blueId, propose } = await library()
  const review = async () => bridge.albumReview({ albumId: blueId })
  assert.deepEqual((await review()).fields, [
    { field: 'title', value: 'Kind of Blue', origin: 'tags', by: undefined, locked: false, undoable: false },
    { field: 'artist', value: 'Miles Davis', origin: 'tags', by: undefined, locked: false, undoable: false },
    { field: 'year', value: YEAR, origin: 'tags', by: undefined, locked: false, undoable: false },
    { field: 'genre', value: 'Jazz', origin: 'tags', by: undefined, locked: false, undoable: false },
  ])
  // A route repairs the title and the year.
  const repaired = await propose('repair-1', [{ kind: 'set-field', subject: { kind: 'album', id: blueId }, field: 'title', value: 'Kind of Blue (Legacy Edition)' }, { kind: 'set-field', subject: { kind: 'album', id: blueId }, field: 'year', value: OTHER_YEAR }])
  assert.equal(repaired.status, 'applied')
  assert.deepEqual(field(await review(), 'title'), { field: 'title', value: 'Kind of Blue (Legacy Edition)', origin: 'route', by: 'route-release', locked: false, undoable: true })
  // The user corrects it: the value is theirs, and undoing it shows the route's value again.
  assert.deepEqual(await bridge.setField({ albumId: blueId, field: 'title', value: '  Kind of Blue (Mono) ' }), { applied: true })
  assert.deepEqual(field(await review(), 'title'), { field: 'title', value: 'Kind of Blue (Mono)', origin: 'user', by: undefined, locked: false, undoable: true })
  assert.deepEqual(await bridge.undoField({ albumId: blueId, field: 'title' }), { status: 'undone' })
  assert.equal(field(await review(), 'title').origin, 'route')
  // Undoing the route's title leaves its year, and the tags show again.
  assert.deepEqual(await bridge.undoField({ albumId: blueId, field: 'title' }), { status: 'undone' })
  assert.deepEqual([field(await review(), 'title').value, field(await review(), 'title').origin, field(await review(), 'year').value], ['Kind of Blue', 'tags', OTHER_YEAR])
  assert.deepEqual(await bridge.undoField({ albumId: blueId, field: 'title' }), { status: 'blocked', reason: 'nothing-to-undo', blockedBy: [] })
  // A locked field refuses the route, not the user.
  assert.deepEqual(await bridge.lockField({ albumId: blueId, field: 'artist', locked: true }), { applied: true })
  assert.equal(field(await review(), 'artist').locked, true)
  assert.equal((await propose('repair-2', [{ kind: 'set-field', subject: { kind: 'album', id: blueId }, field: 'artist', value: 'Miles Davis Sextet' }])).reason, 'locked')
  assert.deepEqual(await bridge.setField({ albumId: blueId, field: 'artist', value: 'Miles Davis Sextet' }), { applied: true })
  assert.deepEqual(await bridge.lockField({ albumId: blueId, field: 'artist', locked: false }), { applied: true })
  assert.equal(field(await review(), 'artist').locked, false)
})

test('the activity list compares each operation of a route change and undoes one of them', async () => {
  const { bridge, blueId, aguasId, propose } = await library()
  await propose('repair-1', [
    { kind: 'set-field', subject: { kind: 'album', id: blueId }, field: 'title', value: 'Kind of Blue (Legacy Edition)' },
    { kind: 'set-field', subject: { kind: 'album', id: aguasId }, field: 'year', value: OTHER_YEAR },
  ])
  const [entry] = (await bridge.activity()).entries
  assert.deepEqual([entry.actor, entry.route, entry.undoable], ['kept', 'route-release', true])
  assert.deepEqual(entry.operations, [
    { index: 0, label: 'Title', before: 'Kind of Blue', after: 'Kind of Blue (Legacy Edition)', undone: false },
    { index: 1, label: 'Year', before: undefined, after: String(OTHER_YEAR), undone: false },
  ])
  assert.deepEqual(await bridge.undo({ id: 'repair-1', operations: [1] }), { status: 'undone' })
  const [partly] = (await bridge.activity()).entries
  assert.deepEqual([partly.undone, partly.operations.map(item => item.undone)], [false, [false, true]])
  assert.equal((await bridge.catalogAlbum({ albumId: blueId })).album.title, 'Kind of Blue (Legacy Edition)')
  assert.equal((await bridge.catalogAlbum({ albumId: aguasId })).album.year, undefined)
  assert.deepEqual(await bridge.undo({ id: 'repair-1' }), { status: 'undone' })
  assert.equal((await bridge.activity()).entries[0].undone, true)
  // A hand-set trait and a favourite name the album by its anchor too.
  assert.deepEqual(await bridge.setFavorite({ albumId: blueId, value: true }), { applied: true })
  assert.deepEqual((await bridge.activity()).entries[0].operations, [{ index: 0, label: 'Favourite', before: 'No', after: 'Yes', undone: false }])
  const older = await bridge.activity({ offset: 1, limit: 1 })
  assert.deepEqual([older.total, older.entries.map(receipt => receipt.id)], [2, [entry.id]])
})

test('requests of the catalog and review operations are validated before they cross IPC', () => {
  const valid = [
    ['catalog-albums', []], ['catalog-albums', [{ offset: 0, limit: 500, sort: 'artist' }]], ['catalog-album', [{ albumId: 'album:1' }]],
    ['catalog-search', [{ query: 'blue', tracks: { offset: 50, limit: 50 } }]], ['playback-links', [{ assetIds: ['asset:1'] }]], ['album-review', [{ albumId: 'album:1' }]],
    ['set-field', [{ albumId: 'album:1', field: 'year', value: YEAR }]], ['lock-field', [{ albumId: 'album:1', field: 'title', locked: true }]],
    ['undo-field', [{ albumId: 'album:1', field: 'genre' }]], ['undo', [{ id: 'change:1', operations: [0] }]], ['set-trait', [{ albumId: 'album:1', trait: 'energy', value: 1 }]],
    ['activity', [{ offset: 1, limit: 2 }]],
  ]
  for (const [method, args] of valid) assert.doesNotThrow(() => validateCatalogBridgeRequest(method, args), method)
  const invalid = [
    ['catalog-albums', [{ limit: 501 }]], ['catalog-album', [{ albumId: '/etc/passwd' }]], ['catalog-search', [{ query: 'blue', tracks: { offset: 0, limit: 101 } }]],
    ['catalog-search', [{ albums: { offset: 0, limit: 1 } }]], ['playback-links', [{ assetIds: ['../x'] }]], ['set-field', [{ albumId: 'album:1', field: 'trait.mood', value: 1 }]],
    ['set-field', [{ albumId: 'album:1', field: 'title', value: '   ' }]], ['set-field', [{ albumId: 'album:1', field: 'year', value: '1959' }]],
    ['lock-field', [{ albumId: 'album:1', field: 'tracks', locked: true }]], ['undo', [{ id: 'change:1', operations: [] }]],
    ['set-trait', [{ albumId: 'album:1', providerAlbumId: 'nd', trait: 'energy', value: 1 }]], ['set-favorite', [{ value: true }]],
    ['activity', [{ offset: -1 }]], ['activity', [{ offset: '1' }]],
  ]
  for (const [method, args] of invalid) assert.throws(() => validateCatalogBridgeRequest(method, args), /Invalid catalog request/, `${method} ${JSON.stringify(args)}`)
})

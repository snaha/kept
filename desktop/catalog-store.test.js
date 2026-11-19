import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createCatalogBridge } from '../shared/catalog-bridge.js'
import { runCatalogContractSuite } from '../shared/catalog-contract-suite.js'
import { CatalogDatabase } from './catalog-database.js'
import { CATALOG_SCHEMA_VERSION, CatalogStore } from './catalog-store.js'

const T1 = 1000, T2 = 2000
const SIZE = 4096
const ENERGY = 80
const FUTURE_VERSION = CATALOG_SCHEMA_VERSION + 1
const LEGACY_LOCATION_SCHEMA = 4
const temporary = () => mkdtempSync(path.join(os.tmpdir(), 'kept-catalog-'))
const folder = { id: 'folder-a', kind: 'local-folder', label: 'Music', evidenceClass: 'deterministic', licence: 'user', policy: { analysisAllowed: true, network: 'none' } }
const navidrome = { id: 'navidrome', kind: 'navidrome', label: 'Navidrome', evidenceClass: 'deterministic', licence: 'user', policy: { analysisAllowed: true, network: 'lan' } }
const snapshot = { sourceId: folder.id, providerSourceId: navidrome.id, observedAt: T1, rootAvailable: true, complete: true,
  files: [{ path: 'Artist/Album/one.flac', contentHash: 'hash-one', size: SIZE, track: 1, providerTrackId: 'nd-one', providerAlbumId: 'nd-album' }] }

// The same suite as the fake, through the worker thread and a real library.sqlite.
runCatalogContractSuite('sqlite catalog service', () => {
  const directory = temporary()
  const file = path.join(directory, 'library.sqlite')
  let database = new CatalogDatabase(file)
  return {
    service: database.service,
    // The worker is closed and the file opened again, as a restart of the app does.
    restart: async () => {
      await database.close()
      database = new CatalogDatabase(file)
      return database.service
    },
    dispose: async () => { await database.close(); rmSync(directory, { recursive: true, force: true }) },
  }
})

test('the catalog survives a restart with its anchors, decisions and consent', t => {
  const directory = temporary()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'library.sqlite')
  let store = new CatalogStore(file)
  store.call('registerSource', folder)
  store.call('registerSource', navidrome)
  const { albumIds: [albumId], assetIds } = store.call('ingestScan', snapshot)
  const album = { kind: 'album', id: albumId }
  store.call('recordUserDecision', { kind: 'trait', subject: album, trait: 'energy', value: ENERGY, decidedAt: T1 })
  store.call('recordUserDecision', { kind: 'favorite', subject: album, value: true, decidedAt: T1 })
  store.call('setConsent', { consent: 'online-lookups', value: 'granted', decidedAt: T1 })
  const before = store.call('getAlbum', { albumId })
  store.close()
  store = new CatalogStore(file)
  t.after(() => store.close())
  assert.equal(store.schemaVersion(), CATALOG_SCHEMA_VERSION)
  assert.deepEqual(store.call('getAlbum', { albumId }), before)
  assert.equal(before.album.traits.energy.value, ENERGY)
  assert.equal(before.album.favorite, true)
  assert.deepEqual(store.call('getConsent'), { 'online-lookups': 'granted', acoustid: 'not-asked', spotify: 'not-asked' })
  assert.deepEqual(store.call('ingestScan', { ...snapshot, observedAt: T2 }), { assetIds, albumIds: [albumId], conflicts: [] })
  assert.deepEqual(store.call('resolveProviderId', { sourceId: navidrome.id, kind: 'album', externalId: 'nd-album' }), { subject: album })
})

test('projections that were never written, or written in another format, are rebuilt on open', t => {
  const directory = temporary()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'library.sqlite')
  let store = new CatalogStore(file)
  store.call('registerSource', folder)
  store.call('registerSource', navidrome)
  const [tagged] = snapshot.files
  const { albumIds: [albumId] } = store.call('ingestScan', { ...snapshot, files: [{ ...tagged, tags: { title: 'One', artist: 'Artist', album: 'Album' } }] })
  store.call('commitChangeSet', { id: 'change-1', author: { kind: 'user' }, operations: [{ kind: 'set-field', subject: { kind: 'album', id: albumId }, field: 'title', value: 'Renamed' }], committedAt: T2 })
  const before = store.call('getCatalogAlbum', { albumId })
  assert.equal(before.album.title, 'Renamed')
  store.close()
  // As a library from before the read model existed: nothing projected, nothing indexed.
  const raw = new DatabaseSync(file)
  raw.exec('DELETE FROM album_projection; DELETE FROM search_rows; DELETE FROM catalog_fts; UPDATE catalog_meta SET value=0 WHERE key=\'projection_format\'')
  raw.close()
  store = new CatalogStore(file)
  t.after(() => store.close())
  const after = store.call('getCatalogAlbum', { albumId })
  assert.deepEqual(after.album, { ...before.album, version: after.version })
  assert.ok(after.version > before.version, 'every album counts as changed, so nothing computed earlier applies blind')
  assert.deepEqual(store.call('searchCatalog', { query: 'renamed' }).albums.map(album => album.id), [albumId])
  assert.deepEqual(store.call('verifyProjections'), { consistent: true, albums: 1, differing: [] })
})

test('upgrading a legacy catalog keeps its streams until ingest can replace them', async t => {
  const directory = temporary()
  const file = path.join(directory, 'library.sqlite')
  let database
  t.after(async () => {
    await database?.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const seed = new CatalogStore(file)
  seed.call('registerSource', folder)
  seed.call('registerSource', navidrome)
  const { albumIds: [albumId], assetIds: [assetId] } = seed.call('ingestScan', snapshot)
  const copy = { ...folder, id: 'legacy-copy' }
  const copyId = 'nd-copy'
  seed.call('registerSource', copy)
  seed.call('ingestScan', { ...snapshot, sourceId: copy.id, files: [{ ...snapshot.files[0], providerTrackId: copyId }] })
  seed.close()
  const raw = new DatabaseSync(file)
  // The old schema recorded track links on assets, with no per-location IDs.
  raw.exec(`
    ALTER TABLE locations DROP COLUMN legacy_playback;
    ALTER TABLE locations DROP COLUMN provider_source_id;
    ALTER TABLE locations DROP COLUMN provider_track_id;
    ALTER TABLE album_tracks DROP COLUMN scan_numbering;
    ALTER TABLE file_hashes DROP COLUMN file_version;
    DROP INDEX search_rows_artist;
    DELETE FROM catalog_meta WHERE key='projection_format';
    PRAGMA user_version=${LEGACY_LOCATION_SCHEMA};
  `)
  raw.close()
  database = new CatalogDatabase(file)
  const bridge = createCatalogBridge(database.service)
  const expectStreams = async (...ids) => {
    const { album } = await bridge.catalogAlbum({ albumId })
    const links = ids.map(externalId => ({ sourceId: navidrome.id, externalId }))
    assert.equal(album.tracks[0].availability, 'available')
    assert.deepEqual(album.tracks[0].links, links)
    assert.deepEqual((await bridge.playbackLinks({ assetIds: [assetId] })).links[assetId], links)
  }
  await expectStreams(copyId, snapshot.files[0].providerTrackId)
  await database.service.ingestScan({ ...snapshot, sourceId: copy.id, observedAt: T2, rootAvailable: false, complete: false, files: [] })
  await expectStreams()
  const providerTrackId = 'nd-after-upgrade'
  await database.service.ingestScan({ ...snapshot, observedAt: T2, files: [{ ...snapshot.files[0], providerTrackId }] })
  await expectStreams(providerTrackId)
})

test('a commit that fails before it is durable leaves no change, no receipt and no projection', t => {
  const directory = temporary()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new CatalogStore(path.join(directory, 'library.sqlite'))
  t.after(() => store.close())
  store.call('registerSource', folder)
  store.call('registerSource', navidrome)
  const { albumIds: [albumId] } = store.call('ingestScan', snapshot)
  const change = { id: 'change-1', author: { kind: 'user' }, operations: [{ kind: 'set-field', subject: { kind: 'album', id: albumId }, field: 'title', value: 'Renamed' }], committedAt: T2 }
  const before = store.call('getCatalogAlbum', { albumId })
  const { insertChangeSet } = store
  store.insertChangeSet = () => { throw new Error('disk full') }
  assert.throws(() => store.call('commitChangeSet', change), /disk full/)
  store.insertChangeSet = insertChangeSet
  assert.deepEqual(store.call('getCatalogAlbum', { albumId }), before)
  assert.equal(store.call('getAlbum', { albumId }).album.fields.title, undefined)
  assert.equal(store.call('listChangeSets', {}).total, 0)
  assert.equal(store.call('verifyProjections').consistent, true)
  // The same change set ID is free to be committed for real.
  const result = store.call('commitChangeSet', change)
  assert.deepEqual([result.status, result.replayed, result.version], ['applied', false, before.version + 1])
  assert.equal(store.call('getCatalogAlbum', { albumId }).album.title, 'Renamed')
})

test('a library from a newer schema is refused and left untouched', t => {
  const directory = temporary()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'library.sqlite')
  new CatalogStore(file).close()
  const raw = new DatabaseSync(file)
  raw.exec(`PRAGMA user_version=${FUTURE_VERSION}`)
  raw.close()
  assert.throws(() => new CatalogStore(file), /newer version of Kept/)
  const check = new DatabaseSync(file)
  t.after(() => check.close())
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, FUTURE_VERSION)
  assert.equal(check.prepare('SELECT count(*) AS n FROM sources').get().n, 1)
})

test('the worker rejects unknown operations and a failed open rejects every call', async t => {
  const directory = temporary()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const database = new CatalogDatabase(path.join(directory, 'library.sqlite'))
  await assert.rejects(database.client.call('dropEverything'), /Unknown catalog operation/)
  await database.close()
  await assert.rejects(database.service.getConsent(), /closing/)
  const broken = new CatalogDatabase(path.join(directory, 'missing-folder', 'library.sqlite'))
  await assert.rejects(broken.service.getConsent())
  await broken.close()
})

test('the scanner remembers and prunes file hashes per source', t => {
  const directory = temporary()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new CatalogStore(path.join(directory, 'library.sqlite'))
  t.after(() => store.close())
  store.call('registerSource', folder)
  const entry = (name, modifiedMs = T1) => ({ path: `${name}.mp3`, fileSize: SIZE, modifiedMs, contentHash: `hash-${name}`, size: SIZE })
  store.call('storeFileHashes', { sourceId: folder.id, entries: [entry('one'), entry('two')] })
  store.call('storeFileHashes', { sourceId: folder.id, entries: [entry('one', T2)], prune: true })
  assert.deepEqual(store.call('fileHashes', { sourceId: folder.id }), { entries: [entry('one', T2)] })
  assert.throws(() => store.call('fileHashes', { sourceId: 'folder-none' }), /^Error: unknown-source:/)
})

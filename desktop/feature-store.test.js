import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCatalogBridge, validateCatalogBridgeRequest } from '../shared/catalog-bridge.js'
import { REFUSED_REASON } from './analysis/analyser.js'
import { ANALYSIS_METHODS, DEFAULT_METHOD_ID, DSP_SIZE, EMBEDDING_SIZE } from './analysis/methods.js'
import { FeatureStore } from './feature-store.js'
import { FeatureDatabase } from './feature-database.js'
import { createFeatureSource, createSoundSimilarity } from './feature-source.js'

const T0 = 7000000
const METHOD = ANALYSIS_METHODS[DEFAULT_METHOD_ID]
const KEY = { method: METHOD.id, version: METHOD.version }

const temporary = t => {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'kept-features-')))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}
const vector = (size, value) => new Float32Array(size).fill(value)
const put = (store, assetId, value, key = KEY) => store.putTrackFeatures({ ...key, assetId, embedding: vector(EMBEDDING_SIZE, value), dsp: vector(DSP_SIZE, value), windows: METHOD.windows, at: T0 })

test('features are kept per asset, method and method version', () => {
  const store = new FeatureStore(':memory:')
  const other = { method: 'openl3-mel256-w15', version: 1 }, next = { method: METHOD.id, version: METHOD.version + 1 }
  put(store, 'asset:a', 1)
  put(store, 'asset:a', 2, other)
  put(store, 'asset:a', 3, next)
  assert.equal(store.getTrackFeatures({ ...KEY, assetId: 'asset:a' }).features.embedding[0], 1)
  assert.equal(store.getTrackFeatures({ ...other, assetId: 'asset:a' }).features.embedding[0], 2)
  const stored = store.getTrackFeatures({ ...next, assetId: 'asset:a' }).features
  assert.deepEqual([stored.embedding.length, stored.dsp.length, stored.embedding[EMBEDDING_SIZE - 1], stored.windows], [EMBEDDING_SIZE, DSP_SIZE, 3, METHOD.windows])
  // A version nobody computed yet has everything still to do, whatever the other versions hold.
  const later = { method: METHOD.id, version: METHOD.version + 2 }
  assert.deepEqual(store.pendingAssets({ ...later, assetIds: ['asset:a', 'asset:b'] }).assetIds, ['asset:a', 'asset:b'])
  assert.deepEqual(store.pendingAssets({ ...KEY, assetIds: ['asset:a', 'asset:b'] }).assetIds, ['asset:b'])
  assert.equal(store.getTrackFeatures({ ...later, assetId: 'asset:a' }).features, undefined)
  // Writing again replaces the row of that key only.
  put(store, 'asset:a', 9)
  assert.equal(store.getTrackFeatures({ ...KEY, assetId: 'asset:a' }).features.embedding[0], 9)
  assert.equal(store.getTrackFeatures({ ...other, assetId: 'asset:a' }).features.embedding[0], 2)
  assert.equal(store.featureCounts({}).tracks, 3)
  // Only the current method version survives a prune.
  store.registerMethod({ ...KEY, licence: METHOD.licence, config: METHOD })
  assert.ok(store.pruneMethods({ keep: [KEY] }).removed >= 2)
  assert.deepEqual(store.featureCounts({}), { tracks: 1, albums: 0, outcomes: { done: 1 } })
  assert.throws(() => store.call('exec', {}), /Unknown feature operation/)
  assert.throws(() => store.putTrackFeatures({ ...KEY, assetId: 'asset:a', embedding: [1], dsp: vector(DSP_SIZE, 0), windows: 1, at: T0 }), /invalid-request/)
  store.close()
})

test('a refusal is asked again, an unreadable file is not, and a refusal removes earlier features', () => {
  const store = new FeatureStore(':memory:')
  put(store, 'asset:a', 1)
  assert.deepEqual(store.recordOutcome({ ...KEY, assetId: 'asset:a', outcome: 'refused', reason: REFUSED_REASON, at: T0 }), { changed: true })
  assert.deepEqual(store.recordOutcome({ ...KEY, assetId: 'asset:a', outcome: 'refused', reason: REFUSED_REASON, at: T0 + 1 }), { changed: false })
  store.recordOutcome({ ...KEY, assetId: 'asset:b', outcome: 'unreadable', reason: 'no audio decoded', at: T0 })
  assert.equal(store.getTrackFeatures({ ...KEY, assetId: 'asset:a' }).features, undefined)
  assert.deepEqual(store.pendingAssets({ ...KEY, assetIds: ['asset:a', 'asset:b'] }).assetIds, ['asset:a'])
  assert.deepEqual(store.listOutcomes({ ...KEY, outcome: 'refused' }).outcomes, [{ assetId: 'asset:a', outcome: 'refused', reason: REFUSED_REASON, at: T0 }])
  assert.deepEqual(store.featureCounts(KEY).outcomes, { refused: 1, unreadable: 1 })
  store.close()
})

test('a legacy unreadable outcome from a missing input stays eligible for analysis', t => {
  const store = new FeatureStore(':memory:')
  t.after(() => store.close())
  const assetId = 'asset:missing'
  store.recordOutcome({ ...KEY, assetId, outcome: 'unreadable', reason: 'ffmpeg exited 1: synthetic.wav: No such file or directory', at: T0 })
  assert.deepEqual(store.pendingAssets({ ...KEY, assetIds: [assetId] }).assetIds, [assetId])
})

test('an album aggregate is the mean of its analysed tracks and follows the album', () => {
  const store = new FeatureStore(':memory:')
  put(store, 'asset:a', 1)
  put(store, 'asset:b', 3)
  const albums = [{ albumId: 'album:x', assetIds: ['asset:a', 'asset:b', 'asset:missing'] }, { albumId: 'album:empty', assetIds: ['asset:missing'] }]
  assert.deepEqual(store.aggregateAlbums({ ...KEY, albums, at: T0 }), { written: 1 })
  const album = store.getAlbumFeatures({ ...KEY, albumId: 'album:x' }).features
  assert.deepEqual([album.tracks, album.embedding[0], album.dsp[DSP_SIZE - 1], album.embedding.length, album.updatedAt], [2, 2, 2, EMBEDDING_SIZE, T0])
  assert.equal(store.getAlbumFeatures({ ...KEY, albumId: 'album:empty' }).features, undefined)
  // Nothing changed: nothing is written.
  assert.deepEqual(store.aggregateAlbums({ ...KEY, albums, at: T0 + 1 }), { written: 0 })
  // A track moved out and the album list is complete: the old album is recomputed, an album that is gone loses its row.
  store.aggregateAlbums({ ...KEY, albums: [{ albumId: 'album:y', assetIds: ['asset:b'] }], at: T0 + 2, complete: true })
  assert.equal(store.getAlbumFeatures({ ...KEY, albumId: 'album:x' }).features, undefined)
  assert.equal(store.getAlbumFeatures({ ...KEY, albumId: 'album:y' }).features.embedding[0], 3)
  store.close()
})

test('features.sqlite is disposable: a deleted or damaged file starts empty', t => {
  const file = path.join(temporary(t), 'features.sqlite')
  const first = new FeatureStore(file)
  put(first, 'asset:a', 1)
  first.close()
  const reopened = new FeatureStore(file)
  assert.equal(reopened.featureCounts({}).tracks, 1)
  reopened.close()
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true })
  const fresh = new FeatureStore(file)
  assert.deepEqual(fresh.pendingAssets({ ...KEY, assetIds: ['asset:a'] }).assetIds, ['asset:a'])
  fresh.close()
  writeFileSync(file, 'this is not a database, and it is long enough to be read as one')
  const replaced = new FeatureStore(file)
  assert.equal(replaced.rebuilt, true)
  assert.equal(replaced.featureCounts({}).tracks, 0)
  put(replaced, 'asset:a', 1)
  replaced.close()
})

test('the feature source gives album and track embeddings of the current method and nothing of a refused asset', async () => {
  const store = new FeatureStore(':memory:')
  const call = method => request => Promise.resolve(store[method](request))
  put(store, 'asset:a', 1)
  put(store, 'asset:b', 3)
  put(store, 'asset:old', 7, { ...KEY, version: KEY.version + 1 })
  store.aggregateAlbums({ ...KEY, at: T0, albums: [{ albumId: 'album:x', assetIds: ['asset:a', 'asset:b'] }] })
  store.recordOutcome({ ...KEY, assetId: 'asset:b', outcome: 'refused', reason: REFUSED_REASON, at: T0 })
  const source = createFeatureSource({ features: { albumEmbeddings: call('albumEmbeddings'), trackEmbeddings: call('trackEmbeddings') }, method: METHOD })
  assert.deepEqual(source.method, { id: METHOD.id, version: String(METHOD.version) })
  const tracks = await source.trackVectors(['asset:a', 'asset:b', 'asset:old', 'asset:none'])
  assert.deepEqual([...tracks.keys()], ['asset:a'])
  assert.equal(tracks.get('asset:a').length, EMBEDDING_SIZE)
  const albums = await source.albumVectors(['album:x', 'album:none'])
  assert.deepEqual([...albums.keys()], ['album:x'])
  assert.equal(albums.get('album:x')[0], 2)
  assert.equal((await source.trackVectors([])).size, 0)
  store.close()
})

test('More like this ranks only sound matches without reading catalog details, locations or history', async t => {
  const database = new FeatureDatabase(':memory:')
  t.after(() => database.close())
  const features = database.store
  const seed = { id: 'album:seed', artist: 'Jexqovr' }
  const candidate = { id: 'album:match', artist: 'Wugzefq' }
  const sameArtist = { id: 'album:same', artist: 'JÉXQOVR' }
  const unavailable = { id: 'album:offline', availability: 'unavailable' }
  const pending = { id: 'album:pending', traits: { energy: { value: 1 } } }
  const albums = [seed, candidate, sameArtist, unavailable, pending].map(album => ({ ...album, version: 1 }))
  const catalog = {
    listCatalogAlbums: async ({ limit }) => ({ albums: albums.slice(0, limit), total: albums.length, version: 1 }),
    getCatalogAlbum: () => assert.fail('similarity must not read album details'),
    getAsset: () => assert.fail('similarity must not read file locations'),
  }
  const bridge = createCatalogBridge(catalog, {
    soundSimilarity: createSoundSimilarity({ catalog, features, method: METHOD }),
  })
  const query = albumId => bridge.similarAlbums(validateCatalogBridgeRequest('similar-albums', [{ albumId }]))
  await Promise.all([seed, candidate, sameArtist, unavailable].map(({ id }) => put(features, id, 1)))
  const aggregates = [seed, sameArtist, unavailable].map(({ id }) => ({ albumId: id, assetIds: [id] }))
  await features.aggregateAlbums({ ...KEY, at: T0, albums: aggregates })
  assert.deepEqual(await query(seed.id), { analysed: true, albumIds: [] })
  await features.aggregateAlbums({ ...KEY, at: T0, albums: [{ albumId: candidate.id, assetIds: [candidate.id] }] })
  assert.deepEqual(await query(seed.id), { analysed: true, albumIds: [candidate.id] })
  assert.deepEqual(await query(pending.id), { analysed: false, albumIds: [] })
  assert.throws(() => validateCatalogBridgeRequest('similar-albums', [{ albumId: '' }]), /Invalid catalog request/)
})

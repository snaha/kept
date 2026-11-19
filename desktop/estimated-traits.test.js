import test from 'node:test'
import assert from 'node:assert/strict'
import { createFakeCatalogService } from '../shared/catalog-fake.js'
import { createCatalogBridge, validateCatalogBridgeRequest } from '../shared/catalog-bridge.js'
import { ANALYSIS_METHODS, DEFAULT_METHOD_ID, DSP_SCALARS, DSP_SIZE } from './analysis/methods.js'
import { FeatureDatabase } from './feature-database.js'
import { MIN_ESTIMATE_ALBUMS, createEstimatedTraits, estimateEnergy } from './estimated-traits.js'

const METHOD = ANALYSIS_METHODS[DEFAULT_METHOD_ID]
const KEY = { method: METHOD.id, version: METHOD.version }
const T0 = 7000000
const ALBUMS = 8
const LOUD_DB = 5, MID_DB = -20
const EXTRA_LOUD_DB = 25
const LARGE_LIBRARY = 30000
const RANKING_BUDGET_MS = 1200
const MIDDLE_PERCENTILE = 50
// An album's signal vector: only the loudness varies, the other features are the same everywhere.
const dsp = loudness => { const vector = new Float32Array(DSP_SIZE); vector[DSP_SCALARS.indexOf('loudnessDb')] = loudness; return vector }
const library = () => Object.fromEntries(Array.from({ length: ALBUMS }, (_, i) => [`album:${i}`, dsp(MID_DB + i * LOUD_DB)]))

test('energy is the album percentile in the library, 0 for the calmest and 100 for the most intense', () => {
  const found = estimateEnergy(library())
  assert.equal(found['album:0'].energy.value, 0)
  assert.equal(found[`album:${ALBUMS - 1}`].energy.value, 100)
  const values = Object.keys(found).sort().map(id => found[id].energy.value)
  assert.deepEqual(values, [...values].sort((a, b) => a - b), 'louder albums score higher')
  assert.ok(values.every(value => Number.isInteger(value) && value >= 0 && value <= 100))
  assert.deepEqual(Object.keys(found['album:3']), ['energy'], 'acoustic and vocal are never estimated')
})

test('a library too small to rank gives no estimate, and a flat one stays in range', () => {
  const small = Object.fromEntries(Object.entries(library()).slice(0, MIN_ESTIMATE_ALBUMS - 1))
  assert.deepEqual(estimateEnergy(small), {})
  const flat = estimateEnergy(Object.fromEntries(Array.from({ length: ALBUMS }, (_, i) => [`album:${i}`, dsp(MID_DB)])))
  assert.ok(Object.values(flat).every(item => item.energy.value >= 0 && item.energy.value <= 100))
})

test('energy ranks a large library within budget and gives ties the same strictly-lower percentile', () => {
  const quiet = dsp(MID_DB)
  const loud = dsp(LOUD_DB)
  const vectors = Object.fromEntries(Array.from({ length: LARGE_LIBRARY }, (_, i) => [`album:${i}`, i % 2 ? loud : quiet]))
  const started = performance.now()
  const found = estimateEnergy(vectors)
  const elapsed = performance.now() - started
  assert.ok(elapsed < RANKING_BUDGET_MS, `ranking ${LARGE_LIBRARY} albums took ${Math.round(elapsed)} ms`)
  assert.equal(Object.keys(found).length, LARGE_LIBRARY)
  assert.deepEqual([found['album:0'].energy.value, found['album:1'].energy.value, found[`album:${LARGE_LIBRARY - 1}`].energy.value], [0, MIDDLE_PERCENTILE, MIDDLE_PERCENTILE])
})

test('the feature worker serves estimates per method version and refreshes them after album changes', async t => {
  const database = new FeatureDatabase(':memory:')
  t.after(() => database.close())
  const { store } = database
  const estimates = createEstimatedTraits({ features: store, method: METHOD })
  assert.deepEqual(await estimates.estimate(), {}, 'an unanalysed library has no estimates')
  const albums = []
  for (const [albumId, vector] of Object.entries(library())) {
    await store.putTrackFeatures({ ...KEY, assetId: `asset:${albumId}`, embedding: new Float32Array(METHOD.embeddingSize).fill(1), dsp: vector, windows: METHOD.windows, at: T0 })
    albums.push({ albumId, assetIds: [`asset:${albumId}`] })
  }
  await store.aggregateAlbums({ ...KEY, albums, at: T0 })
  const found = await estimates.estimate()
  const loudest = albums.at(-1)
  assert.equal(found[loudest.albumId].energy.value, 100)
  assert.deepEqual(await estimates.estimate(), found)
  await store.aggregateAlbums({ ...KEY, albums: albums.slice(0, -1), complete: true, at: T0 })
  assert.equal((await estimates.estimate())[loudest.albumId], undefined, 'a removal with no new timestamps invalidates the ranking')

  const quietest = albums[0]
  await store.putTrackFeatures({ ...KEY, assetId: quietest.assetIds[0], embedding: new Float32Array(METHOD.embeddingSize).fill(1), dsp: dsp(EXTRA_LOUD_DB), windows: METHOD.windows, at: T0 })
  await store.aggregateAlbums({ ...KEY, albums: [quietest], at: T0 })
  assert.equal((await estimates.estimate())[quietest.albumId].energy.value, 100, 'a same-count, same-timestamp edit is visible')
  assert.deepEqual((await store.estimateAlbumEnergy({ ...KEY, version: KEY.version + 1 })).albums, {})
  await estimates.estimate()
  await store.pruneMethods({ keep: [] })
  assert.deepEqual(await estimates.estimate(), {})
})

test('the bridge serves estimates as a view: hand-set decisions stay untouched and nothing is recorded', async () => {
  const service = createFakeCatalogService()
  const sourcesBefore = (await service.listSources()).sources.length
  const bridge = createCatalogBridge(service, {
    estimates: { estimate: async () => ({ 'album:x': { energy: { value: 70 } } }) },
  })
  assert.deepEqual(await bridge.estimatedTraits(), { albums: { 'album:x': { energy: { value: 70 } } } })
  assert.deepEqual(validateCatalogBridgeRequest('estimated-traits', []), undefined)
  assert.throws(() => validateCatalogBridgeRequest('estimated-traits', [{ any: 1 }]))
  assert.deepEqual(await createCatalogBridge(service).estimatedTraits(), { albums: {} }, 'no feature store: no estimates')
  assert.equal((await service.listSources()).sources.length, sourcesBefore, 'serving estimates registers nothing in the catalog')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CatalogStore, STORE_METHODS } from './catalog-store.js'
import { LibraryWorker } from './library-worker.js'
import { ResourcePolicy } from './resource-policy.js'
import { createFakeCatalogService } from '../shared/catalog-fake.js'
import { createFakeFeatureSource } from '../shared/feature-fake.js'
import { createToolRunner } from '../shared/tool-runner.js'
import { routeSource, validateSource } from '../shared/catalog-rules.js'
import { assertAnalysable } from '../shared/source-policy.js'
import { SPOTIFY_SOURCE, SPOTIFY_SOURCE_ID, spotifyCatalogId } from '../shared/spotify-source.js'

const folder = { id: 'folder-a', kind: 'local-folder', label: 'Music', evidenceClass: 'deterministic', licence: 'user', policy: { analysisAllowed: true, network: 'none' } }
const navidrome = { id: 'navidrome', kind: 'navidrome', label: 'Navidrome', evidenceClass: 'deterministic', licence: 'user', policy: { analysisAllowed: true, network: 'lan' } }
const T1 = 1000
const TRACKS = 2
const SPOTIFY_TRACK = spotifyCatalogId('4uLU6hMCjMI75M1A2tKUQC')

test('the spotify source is playback only and needs the spotify consent before any route may use it', async () => {
  assert.equal(validateSource(SPOTIFY_SOURCE), SPOTIFY_SOURCE)
  assert.equal(SPOTIFY_SOURCE.policy.analysisAllowed, false)
  assert.equal(SPOTIFY_SOURCE.policy.network, 'internet')
  assert.throws(() => validateSource({ ...SPOTIFY_SOURCE, policy: { ...SPOTIFY_SOURCE.policy, analysisAllowed: true } }), /spotify can never be analysed/)
  assert.throws(() => assertAnalysable(SPOTIFY_SOURCE, 'analyse'), /not allowed to be analysed/)

  const catalog = createFakeCatalogService()
  await catalog.registerSource(SPOTIFY_SOURCE)
  const before = (await catalog.listSources()).sources.find(source => source.id === SPOTIFY_SOURCE_ID)
  assert.equal(before.consentState, 'not-asked')
  assert.equal(routeSource(before).status, 'not-permitted-by-user', 'off by default')
  await catalog.setConsent({ consent: 'spotify', value: 'granted', decidedAt: T1 })
  const after = (await catalog.listSources()).sources.find(source => source.id === SPOTIFY_SOURCE_ID)
  assert.equal(routeSource(after).status, 'permitted')
  assert.equal(after.policy.analysisAllowed, false, 'consent never allows analysis')
})

test('an analysis job for a source that may not be analysed is refused when queued', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'kept-spotify-'))
  const raw = new CatalogStore(path.join(directory, 'library.sqlite'))
  t.after(() => { raw.close(); rmSync(directory, { recursive: true, force: true }) })
  const store = Object.fromEntries(STORE_METHODS.map(method => [method, async request => raw.call(method, request)]))
  await store.registerSource(folder)
  await store.registerSource(SPOTIFY_SOURCE)
  const ran = []
  const executor = { setGate: () => {}, run: async job => { ran.push(job.id); return {} }, abort: () => {}, close: async () => {} }
  const classes = [{ name: 'analyse', process: 'library', module: 'file:///unused.js', analysis: true }, { name: 'plain', process: 'library', module: 'file:///unused.js' }]
  const worker = new LibraryWorker({ store, classes, policy: new ResourcePolicy(), executorFor: () => executor })

  await assert.rejects(worker.enqueue([{ class: 'analyse', subject: 'asset-1', payload: { sourceId: SPOTIFY_SOURCE_ID } }]), /not allowed to be analysed/)
  await assert.rejects(worker.enqueue([{ class: 'analyse', subject: 'asset-2', payload: { sourceId: 'unknown' } }]), /unknown source/)
  assert.equal((await worker.enqueue([{ class: 'analyse', subject: 'asset-3', payload: { sourceId: folder.id } }])).length, 1)
  assert.equal((await worker.enqueue([{ class: 'plain', subject: 'asset-4', payload: { sourceId: SPOTIFY_SOURCE_ID } }])).length, 1, 'only analysis classes check the policy')
  assert.deepEqual(ran, [])
})

test('the tools never seed from, score or return a spotify entity, whatever a feature store holds', async () => {
  const catalog = createFakeCatalogService()
  await catalog.registerSource(folder)
  await catalog.registerSource(navidrome)
  const files = Array.from({ length: TRACKS }, (_, index) => ({
    path: `Rock/Alpha/Blue/0${index + 1}.flac`, contentHash: `hash-${index}`, size: 4096, duration: 100, track: index + 1, providerTrackId: `nd-${index}`, providerAlbumId: 'nd-blue', tags: { title: `Blue ${index + 1}`, artist: 'Alpha', album: 'Blue', albumArtist: 'Alpha' },
  }))
  await catalog.ingestScan({ sourceId: folder.id, providerSourceId: navidrome.id, observedAt: T1, rootAvailable: true, complete: true, files })
  const [album] = (await catalog.listCatalogAlbums({})).albums
  const asked = []
  const inner = createFakeFeatureSource({ albums: { [album.id]: [1, 0], [SPOTIFY_TRACK]: [1, 0] }, tracks: { [SPOTIFY_TRACK]: [1, 0] } })
  const features = { ...inner, albumVectors: async ids => { asked.push(...ids); return inner.albumVectors(ids) }, trackVectors: async ids => { asked.push(...ids); return inner.trackVectors(ids) } }
  const runner = createToolRunner({ catalog, features })

  await assert.rejects(runner.run('find_similar', { seed: { kind: 'track', id: SPOTIFY_TRACK } }), /analysis refused/)
  await assert.rejects(runner.run('rank_tracks', { occurrenceIds: ['a'], similarTo: { kind: 'track', id: SPOTIFY_TRACK } }), /analysis refused/)
  await assert.rejects(runner.run('build_queue', { seeds: [{ kind: 'track', id: SPOTIFY_TRACK }], length: 3 }), /analysis refused/)

  const similar = await runner.run('find_similar', { seed: { kind: 'album', id: album.id } })
  assert.ok(similar.output.results.every(item => item.ref.id !== SPOTIFY_TRACK))
  const ranked = await runner.run('rank_tracks', { occurrenceIds: [SPOTIFY_TRACK] })
  assert.deepEqual(ranked.output.ranked, [])
  assert.ok(!asked.includes(SPOTIFY_TRACK), 'a spotify id never reaches the feature store')
  const queue = await runner.run('build_queue', { seeds: [{ kind: 'album', id: album.id }], length: 5 })
  assert.ok(!queue.output.occurrenceIds.includes(SPOTIFY_TRACK))
})

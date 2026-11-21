import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { createFakeCatalogService } from '../shared/catalog-fake.js'
import { createCatalogBridge, validateCatalogBridgeRequest } from '../shared/catalog-bridge.js'
import { createFakeFeatureSource } from '../shared/feature-fake.js'
import { MAX_SEARCH_LIMIT } from '../shared/catalog-projection.js'
import { ID_PATTERN } from '../shared/catalog-rules.js'
import { createToolRunner } from '../shared/tool-runner.js'
import { ALBUM_SPACING, ARTIST_SPACING, FOLDER_BONUS_WEIGHT, hybridScore } from '../shared/tool-support.js'
import { CatalogDatabase } from './catalog-database.js'
import { MusicStore } from './music-store.js'
import { createHistoryStats } from './tool-services.js'

const T1 = 1000, SIZE = 4096, SECONDS = 100, TRACKS = 3, PLAYS = 40, QUEUE = 9, ENERGY = 80, LOW_ENERGY = 20
const PROJECTION_QUERY_LIMIT = 200
const folder = { id: 'folder-a', kind: 'local-folder', label: 'Music', evidenceClass: 'deterministic', licence: 'user', policy: { analysisAllowed: true, network: 'none' } }
const navidrome = { id: 'navidrome', kind: 'navidrome', label: 'Navidrome', evidenceClass: 'deterministic', licence: 'user', policy: { analysisAllowed: true, network: 'lan' } }
const SECRET_LYRICS = 'la la la secret lyric line'

// Albums: artist, top-level folder and the album vector. blue is the seed in most tests.
const ALBUMS = {
  blue: { artist: 'Alpha', title: 'Blue', top: 'Rock', vector: [1, 0, 0] },
  blue2: { artist: 'Alpha', title: 'Blue Two', top: 'Rock', vector: [0.99, 0.1, 0] },
  rockclose: { artist: 'Beta', title: 'Rock Close', top: 'Rock', vector: [0.8, 0.6, 0] },
  jazzclose: { artist: 'Gamma', title: 'Jazz Close', top: 'Jazz', vector: [0.9, 0.436, 0] },
  eps: { artist: 'Eps', title: 'Epsilon', top: 'Rock', vector: [0.5, 0.866, 0] },
  far: { artist: 'Delta', title: 'Far Away', top: 'Jazz', vector: [0, 0, 1] },
  twin: { artist: 'Zeta', title: 'Twin', top: 'Rock', vector: [0.5, 0.866, 0] },
}
const KEYS = Object.keys(ALBUMS)

// One scan with every album, three tracks each, through the real service under test.
async function fixture(service) {
  await service.registerSource(folder)
  await service.registerSource(navidrome)
  const files = KEYS.flatMap(key => Array.from({ length: TRACKS }, (_, index) => {
    const { artist, title, top } = ALBUMS[key]
    return {
      path: `${top}/${artist}/${title}/0${index + 1}.flac`, contentHash: `hash-${key}-${index}`, size: SIZE, duration: SECONDS, track: index + 1,
      providerTrackId: `nd-${key}-${index}`, providerAlbumId: `nd-${key}`, tags: { title: `${title} ${index + 1}`, artist, album: title, albumArtist: artist },
    }
  }))
  const result = await service.ingestScan({ sourceId: folder.id, providerSourceId: navidrome.id, observedAt: T1, rootAvailable: true, complete: true, files })
  const ids = {}, assets = {}
  for (const key of KEYS) {
    const { subject } = await service.resolveProviderId({ sourceId: navidrome.id, kind: 'album', externalId: `nd-${key}` })
    ids[key] = subject.id
    assets[key] = (await service.getCatalogAlbum({ albumId: subject.id })).album.tracks.map(track => ({ id: track.id, assetId: track.assetId }))
  }
  const features = createFakeFeatureSource({ albums: Object.fromEntries(KEYS.map(key => [ids[key], ALBUMS[key].vector])) })
  const keyOf = Object.fromEntries(KEYS.map(key => [ids[key], key]))
  return { ids, assets, features, keyOf, result }
}
const history = plays => ({ albumStats: async () => Object.fromEntries(Object.entries(plays).map(([id, count]) => [id, { plays: count, lastPlayed: T1 }])) })
const album = id => ({ kind: 'album', id })
const track = id => ({ kind: 'track', id })

async function setup(overrides = {}) {
  const catalog = overrides.catalog ?? createFakeCatalogService()
  const world = await fixture(catalog)
  const runner = createToolRunner({ catalog, features: world.features, ...overrides.services })
  return { catalog, runner, ...world }
}
// eps and twin tie everywhere: the lower ID comes first.
const tiedOrder = world => ['eps', 'twin'].sort((a, b) => (world.ids[a] < world.ids[b] ? -1 : 1))
const names = (world, items) => items.map(item => world.keyOf[item.ref?.id ?? item.id])

test('search_catalog finds albums and tracks by words, filters them and ranks best first', async () => {
  const world = await setup()
  const { output } = await world.runner.run('search_catalog', { query: 'blue' })
  assert.deepEqual(names(world, output.results.filter(item => item.ref.kind === 'album')), ['blue', 'blue2'])
  assert.ok(output.results.some(item => item.ref.kind === 'track'))
  assert.equal(output.results[0].score, 1)
  assert.ok(output.results.every((item, index) => index === 0 || item.score <= output.results[index - 1].score))
  assert.deepEqual(names(world, (await world.runner.run('search_catalog', { query: 'blue', kinds: ['album'], limit: 1 })).output.results), ['blue'])

  await world.catalog.recordUserDecision({ kind: 'favorite', subject: { kind: 'album', id: world.ids.blue2 }, value: true, decidedAt: T1 })
  await world.catalog.recordUserDecision({ kind: 'trait', subject: { kind: 'album', id: world.ids.far }, trait: 'energy', value: ENERGY, decidedAt: T1 })
  const favourites = await world.runner.run('search_catalog', { query: 'blue', kinds: ['album'], favorite: true })
  assert.deepEqual(names(world, favourites.output.results), ['blue2'], 'a change in the catalog is seen by the next call')
  const loud = await world.runner.run('search_catalog', { query: '', kinds: ['album'], traits: { energy: { min: ENERGY - 1 } } })
  assert.deepEqual(names(world, loud.output.results), ['far'], 'an empty query lists on the filters; an item without the trait is out')
  assert.deepEqual((await world.runner.run('search_catalog', { query: 'zzzz' })).output.results, [])
})

test('search_catalog pages past hits the filters reject', async () => {
  const world = await setup()
  await world.catalog.recordUserDecision({ kind: 'favorite', subject: { kind: 'album', id: world.ids.blue2 }, value: true, decidedAt: T1 })
  const PAGE = 100
  const asHit = id => ({ id, favorite: false, availability: 'available', traits: {}, locks: [], trackCount: 1, version: 1 })
  const calls = []
  // The first page is all blue, which is no favourite; the favourite only turns up on the second.
  const paged = { ...world.catalog, searchCatalog: async request => {
    calls.push(request.offset ?? 0)
    return { albums: request.offset ? [asHit(world.ids.blue2)] : Array.from({ length: PAGE }, () => asHit(world.ids.blue)), tracks: [], artists: [], version: 1 }
  } }
  const runner = createToolRunner({ catalog: paged, features: world.features })
  const found = await runner.run('search_catalog', { query: 'blue', kinds: ['album'], favorite: true })
  assert.deepEqual(names(world, found.output.results), ['blue2'])
  assert.deepEqual(calls, [0, PAGE])
})

test('search_catalog validates the projection query limit before searching', async () => {
  const { runner } = await setup()
  const query = 'x'.repeat(PROJECTION_QUERY_LIMIT)
  assert.deepEqual((await runner.run('search_catalog', { query })).output.results, [])
  await assert.rejects(runner.run('search_catalog', { query: query + 'x' }), /Invalid search_catalog input\.query: wrong length/)
})

test('mixed search exhausts album hits across page boundaries before using tracks', async () => {
  const catalog = createFakeCatalogService()
  await catalog.registerSource(folder)
  await catalog.registerSource(navidrome)
  const title = 'Veskivox Needlework Fixture'
  const albumCount = MAX_SEARCH_LIMIT + 1
  const files = Array.from({ length: albumCount }, (_, index) => ({
    path: `Fixture Shelf/${index}/fixture.flac`, contentHash: `fixture-order-${index}`, size: SIZE, track: 1,
    providerAlbumId: `fixture-album-${index}`, providerTrackId: `fixture-track-${index}`,
    tags: { title, album: `${title} ${index}`, artist: 'Veskivox 9Q' },
  }))
  await catalog.ingestScan({ sourceId: folder.id, providerSourceId: navidrome.id, observedAt: T1, rootAvailable: true, complete: true, files })
  const runner = createToolRunner({ catalog })
  const { output } = await runner.run('search_catalog', { query: title, limit: albumCount + 1 })
  assert.deepEqual(output.results.map(({ ref }) => ref.kind), [...files.map(() => 'album'), 'track'])
})

test('warm track similarity checks the catalog version once for the whole operation', async () => {
  const world = await setup()
  let versionReads = 0
  const catalog = {
    ...world.catalog,
    listCatalogAlbums(request) {
      versionReads++
      return world.catalog.listCatalogAlbums(request)
    },
  }
  const runner = createToolRunner({ catalog, features: world.features })
  const input = { seed: album(world.ids.blue), kind: 'track' }
  const cold = await runner.run('find_similar', input)
  versionReads = 0
  assert.deepEqual(await runner.run('find_similar', input), cold)
  assert.ok(cold.output.results.length > 0)
  assert.equal(versionReads, 1)
})

test('a cold track search starts other album reads while the first one is pending', async () => {
  const world = await setup()
  const firstRead = Promise.withResolvers()
  const started = Promise.withResolvers()
  const albumIds = []
  const catalog = {
    ...world.catalog,
    async getCatalogAlbum(request) {
      albumIds.push(request.albumId)
      if (albumIds.length === 1) {
        started.resolve()
        await firstRead.promise
      }
      return world.catalog.getCatalogAlbum(request)
    },
  }
  const runner = createToolRunner({ catalog })
  const input = { query: '', kinds: ['track'], limit: 2 }
  const pending = runner.run('search_catalog', input)
  await started.promise
  await setImmediate()
  const simultaneousReads = albumIds.length
  firstRead.resolve()
  const result = await pending
  assert.ok(simultaneousReads > 1)
  assert.deepEqual(result.output, (await world.runner.run('search_catalog', input)).output)
})

test('build_queue loads enough albums when the best ones hold many tracks', async () => {
  const catalog = createFakeCatalogService()
  await catalog.registerSource(folder)
  await catalog.registerSource(navidrome)
  const ALBUM_COUNT = 30, PER_ALBUM = 10
  const files = Array.from({ length: ALBUM_COUNT }, (_, a) => Array.from({ length: PER_ALBUM }, (_, t) => ({
    path: `Rock/Artist ${a}/Album ${a}/${t + 1}.flac`, contentHash: `h-${a}-${t}`, size: SIZE, duration: SECONDS, track: t + 1,
    providerTrackId: `t-${a}-${t}`, providerAlbumId: `a-${a}`, tags: { title: `Song ${a} ${t}`, artist: `Artist ${a}`, album: `Album ${a}`, albumArtist: `Artist ${a}` },
  }))).flat()
  await catalog.ingestScan({ sourceId: folder.id, providerSourceId: navidrome.id, observedAt: T1, rootAvailable: true, complete: true, files })
  const { subject } = await catalog.resolveProviderId({ sourceId: navidrome.id, kind: 'album', externalId: 'a-0' })
  const runner = createToolRunner({ catalog, features: createFakeFeatureSource({ albums: {} }) })
  const result = await runner.run('build_queue', { seeds: [{ kind: 'album', id: subject.id }], length: ALBUM_COUNT, maxPerAlbum: 1 })
  assert.equal(result.output.occurrenceIds.length, ALBUM_COUNT, 'one track of every album, not a short queue from the first few')
})

test('find_similar is sound only: the folder bonus is 0, so a closer sound beats the same folder', async () => {
  const world = await setup()
  assert.equal(FOLDER_BONUS_WEIGHT, 0)
  const { output } = await world.runner.run('find_similar', { seed: album(world.ids.blue) })
  // jazzclose: cosine 0.9, another folder; rockclose: cosine 0.8 and the seed's folder.
  assert.deepEqual(names(world, output.results), ['jazzclose', 'rockclose', ...tiedOrder(world), 'far'])
  assert.ok(output.results.every(item => item.basis === 'sound'))
  assert.ok(Math.abs(output.results[0].score - 0.9) < 1e-3)
  assert.equal(hybridScore(0.8, true), hybridScore(0.8, false))
  const withArtist = await world.runner.run('find_similar', { seed: album(world.ids.blue), excludeSeedArtist: false })
  assert.equal(names(world, withArtist.output.results)[0], 'blue2')
  assert.ok(!names(world, withArtist.output.results).includes('blue'), 'never the seed itself')
})

test('find_similar breaks ties by ID and gives the same answer every time', async () => {
  const world = await setup()
  const first = await world.runner.run('find_similar', { seed: album(world.ids.blue) })
  const again = await createToolRunner({ catalog: world.catalog, features: world.features }).run('find_similar', { seed: album(world.ids.blue) })
  assert.deepEqual(again, first)
  // eps and twin have the same vector and folder, so their scores are equal and the lower ID goes first.
  const equal = first.output.results.filter(item => ['eps', 'twin'].includes(world.keyOf[item.ref.id]))
  assert.equal(equal[0].score, equal[1].score)
  assert.ok(equal[0].ref.id < equal[1].ref.id)
})

test('find_similar novelty prefers what the user has not played, and 0 what they have', async () => {
  const world = await setup()
  const played = history({ [world.ids.rockclose]: PLAYS })
  const runner = createToolRunner({ catalog: world.catalog, features: world.features, history: played })
  const novel = await runner.run('find_similar', { seed: album(world.ids.blue), novelty: 1 })
  assert.deepEqual(names(world, novel.output.results).slice(0, 2), ['jazzclose', 'eps'])
  const familiar = await runner.run('find_similar', { seed: album(world.ids.blue), novelty: 0 })
  assert.equal(names(world, familiar.output.results)[0], 'rockclose')
  const plain = await runner.run('find_similar', { seed: album(world.ids.blue) })
  assert.equal(names(world, plain.output.results)[0], 'jazzclose', 'without a novelty the history is not used')
})

test('find_similar without features falls back to traits, then to the folder, and says so', async () => {
  const world = await setup()
  const bare = createToolRunner({ catalog: world.catalog })
  const folderOnly = await bare.run('find_similar', { seed: album(world.ids.blue) })
  assert.deepEqual(new Set(names(world, folderOnly.output.results)), new Set(['rockclose', 'eps', 'twin']))
  assert.ok(folderOnly.output.results.every(item => item.basis === 'metadata'))
  for (const key of ['blue', 'rockclose', 'jazzclose']) await world.catalog.recordUserDecision({ kind: 'trait', subject: { kind: 'album', id: world.ids[key] }, trait: 'energy', value: key === 'jazzclose' ? LOW_ENERGY : ENERGY, decidedAt: T1 })
  const traits = await bare.run('find_similar', { seed: album(world.ids.blue) })
  assert.deepEqual(names(world, traits.output.results), ['rockclose', 'jazzclose'])
  assert.ok(traits.output.results.every(item => item.basis === 'traits'))
  const broken = { ...world.features, albumVectors: async () => { throw new Error('features.sqlite is locked') } }
  const fallback = await createToolRunner({ catalog: world.catalog, features: broken }).run('find_similar', { seed: album(world.ids.blue) })
  assert.ok(fallback.output.results.every(item => item.basis === 'traits'), 'a failing feature store does not take the tool down')
})

test('find_similar can answer with tracks, from a track seed', async () => {
  const world = await setup()
  const seed = world.assets.blue[0]
  const tracks = Object.fromEntries(world.assets.rockclose.map(item => [item.assetId, ALBUMS.rockclose.vector]))
  const features = createFakeFeatureSource({ albums: Object.fromEntries(KEYS.map(key => [world.ids[key], ALBUMS[key].vector])), tracks: { [seed.assetId]: ALBUMS.blue.vector, ...tracks } })
  const { output } = await createToolRunner({ catalog: world.catalog, features }).run('find_similar', { seed: track(seed.id), kind: 'track', limit: 5 })
  assert.ok(output.results.every(item => item.ref.kind === 'track'))
  assert.ok(!output.results.some(item => item.ref.id === seed.id))
  const owners = new Set(output.results.map(item => world.keyOf[Object.keys(world.keyOf).find(id => world.assets[world.keyOf[id]].some(entry => entry.id === item.ref.id))]))
  assert.ok(!owners.has('blue') && !owners.has('blue2'))
  assert.equal([...owners][0], 'jazzclose', 'the closer sound leads, whatever the folder')
})

test('rank_tracks orders by trait fit, similarity and novelty, keeping the caller order on ties', async () => {
  const world = await setup()
  const pick = key => world.assets[key].map(item => item.id)
  await world.catalog.recordUserDecision({ kind: 'trait', subject: { kind: 'album', id: world.ids.rockclose }, trait: 'energy', value: ENERGY, decidedAt: T1 })
  await world.catalog.recordUserDecision({ kind: 'trait', subject: { kind: 'album', id: world.ids.jazzclose }, trait: 'energy', value: LOW_ENERGY, decidedAt: T1 })
  const occurrenceIds = [...pick('jazzclose'), ...pick('rockclose')]
  const byTrait = await world.runner.run('rank_tracks', { occurrenceIds, traits: { energy: ENERGY } })
  assert.deepEqual(byTrait.output.ranked.map(item => item.occurrenceId), [...pick('rockclose'), ...pick('jazzclose')])
  assert.equal(byTrait.output.ranked[0].score, 1)
  const bySound = await world.runner.run('rank_tracks', { occurrenceIds: [...pick('far'), ...pick('rockclose')], similarTo: album(world.ids.blue) })
  assert.deepEqual(bySound.output.ranked.map(item => item.occurrenceId).slice(0, TRACKS), pick('rockclose'))
  const plain = await world.runner.run('rank_tracks', { occurrenceIds })
  assert.deepEqual(plain.output.ranked.map(item => item.occurrenceId), occurrenceIds, 'no scoring part: the given order stays')
  const runner = createToolRunner({ catalog: world.catalog, features: world.features, history: history({ [world.ids.rockclose]: PLAYS }) })
  const fresh = await runner.run('rank_tracks', { occurrenceIds: [...pick('rockclose'), ...pick('far')], novelty: 1 })
  assert.deepEqual(fresh.output.ranked.map(item => item.occurrenceId).slice(0, TRACKS), pick('far'))
  const limited = await world.runner.run('rank_tracks', { occurrenceIds, limit: 2 })
  assert.equal(limited.output.ranked.length, 2)
})

test('rank_tracks drops IDs the catalog does not hold and counts them', async () => {
  const world = await setup()
  const real = world.assets.blue[0].id
  const result = await world.runner.run('rank_tracks', { occurrenceIds: [real, 'occurrence:not-in-the-catalog', real] })
  assert.deepEqual(result.output.ranked.map(item => item.occurrenceId), [real])
  assert.equal(result.dropped, 1)
})

test('build_queue starts from the seeds, has no duplicates and spaces artists and albums', async () => {
  const world = await setup()
  const seedTrack = world.assets.rockclose[1].id
  const { output } = await world.runner.run('build_queue', { seeds: [track(seedTrack), album(world.ids.blue)], length: QUEUE, maxPerAlbum: 2 })
  assert.equal(output.occurrenceIds.length, QUEUE)
  assert.equal(output.occurrenceIds[0], seedTrack)
  assert.equal(output.occurrenceIds[1], world.assets.blue[0].id, 'an album seed opens with its first track')
  assert.equal(new Set(output.occurrenceIds).size, QUEUE)
  const albumOf = Object.fromEntries(KEYS.flatMap(key => world.assets[key].map(item => [item.id, key])))
  const queued = output.occurrenceIds.map(id => albumOf[id])
  for (const key of KEYS) assert.ok(queued.filter(name => name === key).length <= 2, `${key} at most twice`)
  // After the seeds, no artist twice within ARTIST_SPACING picks and no album within ALBUM_SPACING while the pool allows it.
  for (let index = 2; index < queued.length; index++) {
    const before = queued.slice(Math.max(2, index - ALBUM_SPACING), index)
    const near = queued.slice(Math.max(2, index - ARTIST_SPACING), index)
    const artist = name => ALBUMS[name].artist
    assert.ok(!near.some(name => name !== queued[index] && artist(name) === artist(queued[index])), 'artists apart')
    if (before.length < ALBUM_SPACING || KEYS.length - 1 >= ALBUM_SPACING) assert.ok(!queued.slice(index - 1, index).includes(queued[index]), 'no album twice in a row')
  }
  const again = await world.runner.run('build_queue', { seeds: [track(seedTrack), album(world.ids.blue)], length: QUEUE, maxPerAlbum: 2 })
  assert.deepEqual(again.output, output)
})

test('build_queue stops at a duration target, comes up short rather than repeat, and ignores unknown seeds', async () => {
  const world = await setup()
  const seeds = [album(world.ids.blue)]
  const timed = await world.runner.run('build_queue', { seeds, length: QUEUE }, { targetSeconds: SECONDS * 4 })
  assert.equal(timed.output.occurrenceIds.length, 4)
  const all = await world.runner.run('build_queue', { seeds, length: 50, maxPerAlbum: 1 })
  assert.equal(all.output.occurrenceIds.length, KEYS.length, 'one per album is all there is')
  const unknown = await world.runner.run('build_queue', { seeds: [album('album:gone'), ...seeds], length: 3 })
  assert.equal(unknown.dropped, 1)
  assert.equal(unknown.output.occurrenceIds.length, 3)
  assert.deepEqual((await world.runner.run('build_queue', { seeds: [album('album:gone')], length: 3 })).output, { occurrenceIds: [] })
})

test('build_queue leaves out tracks and albums that are not available', async () => {
  const world = await setup()
  await world.catalog.ingestScan({ sourceId: folder.id, providerSourceId: navidrome.id, observedAt: T1 + 1, rootAvailable: false, complete: false, files: [] })
  const result = await world.runner.run('build_queue', { seeds: [album(world.ids.blue)], length: QUEUE })
  assert.deepEqual(result.output.occurrenceIds, [])
})

test('track searches and ranking stop offering occurrences when their source disconnects', async () => {
  const world = await setup()
  const occurrenceIds = world.assets.blue.map(item => item.id)
  const browse = { query: '', kinds: ['track'] }
  const search = { ...browse, query: ALBUMS.blue.title }
  assert.ok((await world.runner.run('search_catalog', browse)).output.results.length > 0)
  assert.ok((await world.runner.run('search_catalog', search)).output.results.length > 0)
  assert.deepEqual((await world.runner.run('rank_tracks', { occurrenceIds })).output.ranked.map(item => item.occurrenceId), occurrenceIds)

  await world.catalog.ingestScan({ sourceId: folder.id, providerSourceId: navidrome.id, observedAt: T1 + 1, rootAvailable: false, complete: false, files: [] })
  assert.deepEqual((await world.runner.run('search_catalog', browse)).output.results, [])
  assert.deepEqual((await world.runner.run('search_catalog', search)).output.results, [])
  const ranked = await world.runner.run('rank_tracks', { occurrenceIds })
  assert.deepEqual(ranked.output.ranked, [])
  assert.equal(ranked.dropped, occurrenceIds.length)
})

// A catalog that lies: its search returns IDs that exist nowhere, a track of the wrong album, and the
// feature store holds vectors for IDs the catalog never had.
function liar(catalog, world) {
  const bogusAlbum = { id: 'album:bogus', favorite: false, availability: 'available', traits: {}, locks: [], trackCount: 1, version: 1 }
  const bogusTrack = { id: 'occurrence:bogus', albumId: 'album:bogus', assetId: 'asset:bogus', position: 1, availability: 'available' }
  const misplaced = { id: world.assets.far[0].id, albumId: world.ids.blue, assetId: 'asset:x', position: 1, availability: 'available' }
  return {
    ...catalog,
    searchCatalog: async request => {
      const found = await catalog.searchCatalog(request)
      return { ...found, albums: [bogusAlbum, ...found.albums], tracks: [bogusTrack, misplaced, ...found.tracks] }
    },
  }
}

test('only real occurrence IDs are ever returned', async () => {
  const world = await setup()
  const bogusVectors = { 'album:bogus': ALBUMS.blue.vector, 'album:ghost': ALBUMS.blue.vector }
  const features = createFakeFeatureSource({ albums: { ...Object.fromEntries(KEYS.map(key => [world.ids[key], ALBUMS[key].vector])), ...bogusVectors }, tracks: { 'asset:bogus': ALBUMS.blue.vector } })
  const runner = createToolRunner({ catalog: liar(world.catalog, world), features })
  const real = new Set([...Object.values(world.ids), ...KEYS.flatMap(key => world.assets[key].map(item => item.id))])
  const outputs = [
    await runner.run('search_catalog', { query: 'blue' }),
    await runner.run('search_catalog', { query: 'a', kinds: ['track'] }),
    await runner.run('find_similar', { seed: album(world.ids.blue), excludeSeedArtist: false, kind: 'track' }),
    await runner.run('find_similar', { seed: album(world.ids.blue), excludeSeedArtist: false }),
    await runner.run('rank_tracks', { occurrenceIds: ['occurrence:bogus', world.assets.blue[0].id], similarTo: album('album:bogus') }),
    await runner.run('build_queue', { seeds: [album('album:bogus'), album(world.ids.blue)], length: QUEUE }),
  ]
  const INVALID_HITS = 3
  assert.equal(outputs[0].dropped, INVALID_HITS, 'the unknown and misplaced hits were each counted once')
  for (const { output } of outputs) {
    const strings = JSON.stringify(output).match(/"(?:album|occurrence|asset):[^"]*"/g) ?? []
    for (const quoted of strings) assert.ok(real.has(JSON.parse(quoted)), `${quoted} is in the catalog`)
  }
  assert.ok(outputs[0].output.results.length > 0)
})

test('outputs hold IDs and scores only: no path, audio, lyrics or text', async () => {
  const world = await setup()
  const real = new Set([...Object.values(world.ids), ...KEYS.flatMap(key => world.assets[key].map(item => item.id))])
  const runs = [
    ['search_catalog', { query: 'blue' }], ['find_similar', { seed: album(world.ids.blue), kind: 'track' }], ['find_similar', { seed: album(world.ids.blue) }],
    ['rank_tracks', { occurrenceIds: world.assets.blue.map(item => item.id) }], ['build_queue', { seeds: [album(world.ids.blue)], length: QUEUE }],
  ]
  const strings = value => (typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [])
  for (const [name, input] of runs) {
    const { output } = await world.runner.run(name, input)
    for (const text of strings(output)) assert.ok(real.has(text) || ['album', 'track', 'sound', 'traits', 'metadata'].includes(text), `${name} returned ${text}`)
    const json = JSON.stringify(output)
    assert.ok(!/flac|Rock\/|Jazz\/|Alpha|Beta|lyric/i.test(json), name)
    for (const id of strings(output).filter(text => real.has(text))) assert.match(id, ID_PATTERN)
  }
  assert.ok(!SECRET_LYRICS.includes('flac'))
})

test('inputs are checked against the contracts before any work is done', async () => {
  const world = await setup()
  await assert.rejects(world.runner.run('find_similar', { seed: album(world.ids.blue), shell: 'rm' }), /shell: not allowed/)
  await assert.rejects(world.runner.run('build_queue', { seeds: [album(world.ids.blue)], length: 0 }), /length: out of range/)
  await assert.rejects(world.runner.run('play_everything', {}), /Unknown tool/)
})

test('the catalog bridge runs the tools and refuses malformed calls', async () => {
  const world = await setup()
  const bridge = createCatalogBridge(world.catalog, { tools: world.runner })
  const request = validateCatalogBridgeRequest('tool', [{ name: 'find_similar', input: { seed: album(world.ids.blue), limit: 2 } }])
  const reply = await bridge.tool(request)
  assert.equal(reply.name, 'find_similar')
  assert.equal(reply.output.results.length, 2)
  assert.deepEqual(JSON.parse(JSON.stringify(reply)), reply)
  assert.throws(() => validateCatalogBridgeRequest('tool', [{ name: 'find_similar', input: {}, extra: 1 }]), /Invalid catalog request/)
  assert.throws(() => validateCatalogBridgeRequest('tool', [{ name: 'find_similar', input: { seed: { kind: 'artist', id: 'a' } } }]), /not one of/)
  assert.throws(() => validateCatalogBridgeRequest('tool', [{ name: 'nope', input: {} }]), /Unknown tool/)
  await assert.rejects(createCatalogBridge(world.catalog).tool(request), /Tools are not available/)
})

test('rank_tracks uses plays persisted under legacy and virtual album IDs', async t => {
  const world = await setup()
  const store = new MusicStore(':memory:')
  t.after(() => store.close())
  const scope = 'desktop:fixture'
  const albumIds = ['local:album:nd-eps', `local:album:${world.ids.eps}`]
  const contextId = 'fixture-history'
  const queue = albumIds.map((albumId, index) => ({
    albumId, id: `fixture-track-${index}`, rawId: `fixture-track-${index}`, title: 'Veskivox Needlework Fixture',
    source: 'local', available: true, cover: '',
  }))
  const entries = queue.map((item, index) => ({ id: item.id, contextId, index, cursor: index, playedAt: T1 + index }))
  store.write({ scope, contexts: [{ id: contextId, queue, order: 'normal', permutation: [0, 1] }], entries })
  const history = createHistoryStats({ stats: () => store.stats({ scope }) })
  const page = await world.catalog.listCatalogAlbums()
  assert.deepEqual(await history.albumStats(new Map(page.albums.map(item => [item.id, item]))), {
    [world.ids.eps]: { plays: entries.length, lastPlayed: T1 + 1 },
  })
  const runner = createToolRunner({ catalog: world.catalog, history })
  const occurrenceIds = [world.assets.eps[0].id, world.assets.twin[0].id]
  const { output } = await runner.run('rank_tracks', { occurrenceIds, novelty: 1 })
  assert.deepEqual(output.ranked.map(item => item.occurrenceId), [...occurrenceIds].reverse())
})

test('the tools run on the SQLite catalog the same way, sound only', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'kept-tools-'))
  const database = new CatalogDatabase(path.join(directory, 'library.sqlite'))
  t.after(async () => { await database.close(); rmSync(directory, { recursive: true, force: true }) })
  const world = await setup({ catalog: database.service })
  const { output } = await world.runner.run('find_similar', { seed: album(world.ids.blue) })
  assert.deepEqual(names(world, output.results), ['jazzclose', 'rockclose', ...tiedOrder(world), 'far'])
  const search = await world.runner.run('search_catalog', { query: 'jazz', kinds: ['album'] })
  assert.deepEqual(names(world, search.output.results), ['jazzclose'])
  const queue = await world.runner.run('build_queue', { seeds: [album(world.ids.blue)], length: 6 })
  assert.equal(queue.output.occurrenceIds.length, 6)
})

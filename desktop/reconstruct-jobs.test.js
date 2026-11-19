import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CatalogStore, STORE_METHODS } from './catalog-store.js'
import { createLibraryJobClasses } from './library-job-classes.js'
import { LibraryWorker } from './library-worker.js'
import { nodeFork } from './library-process.js'
import { createLibraryService } from './library-service.js'
import { MUSICBRAINZ_SOURCE_ID } from '../shared/reconstruct.js'
import { RECONSTRUCT_CLASS, createReconstructJobs } from './reconstruct-jobs.js'
import { ResourcePolicy } from './resource-policy.js'
import { installNetworkGuard } from './tests/network-guard.js'

// The `reconstruct` job class end to end: the queue, the claim-time cluster, the handler module and
// the commit through the ledger. The handler runs in this process, so the network guard sees
// everything it does. One test runs it in a real worker process.

const T0 = 1000
const TEST_APP_VERSION = '0.0.0-preview.test'
const JOB_TIMEOUT_MS = 15000
const SIZE = 4096
const LENGTH = 200
const RELEASE_ID = '11111111-1111-4111-8111-111111111111'
const GROUP_ID = '33333333-3333-4333-8333-333333333333'
const TITLES = ['Harbour Lights', 'Paper Lanterns', 'Salt and Iron', 'The Long Way Down', 'Quiet Machines', 'Low Tide']
const FOLDER = { id: 'folder-a', kind: 'local-folder', label: 'Music', evidenceClass: 'deterministic', licence: 'user', policy: { analysisAllowed: true, network: 'none' } }
const NAVIDROME = { id: 'navidrome', kind: 'navidrome', label: 'Navidrome', evidenceClass: 'deterministic', licence: 'user', policy: { analysisAllowed: true, network: 'lan' } }
const reconstructClass = createLibraryJobClasses({ appVersion: TEST_APP_VERSION }).find(definition => definition.name === RECONSTRUCT_CLASS)

// One album whose artist is spelled two ways, so the scanner filed it as two, without a year.
const snapshot = () => ({
  sourceId: FOLDER.id, providerSourceId: NAVIDROME.id, observedAt: T0, rootAvailable: true, complete: true,
  files: TITLES.map((title, index) => {
    const artist = index % 2 ? 'TheBand' : 'The Band'
    return {
      path: `Tidewater/${String(index + 1).padStart(2, '0')} - ${title}.flac`, contentHash: `hash-${index}`, size: SIZE, duration: LENGTH + index, track: index + 1,
      providerTrackId: `nd-track-${index}`, providerAlbumId: `nd-album-${artist}`, tags: { title, artist, album: 'Tidewater' },
    }
  }),
})
// MusicBrainz as it answers, with the parts Kept must not keep.
const releaseBody = {
  id: RELEASE_ID, title: 'Tidewater', date: '2001-03-04', status: 'Official', tags: [{ name: 'rock' }], genres: [{ name: 'rock' }],
  'artist-credit': [{ name: 'The Band', joinphrase: '' }], 'release-group': { id: GROUP_ID, 'first-release-date': '2001-03-04', genres: [{ name: 'rock' }] },
  media: [{ position: 1, tracks: TITLES.map((title, index) => ({ position: index + 1, title, length: (LENGTH + index) * T0, recording: { id: `rec-${index}`, tags: [{ name: 'rock' }] } })) }],
}

const open = (t, { execute } = {}) => {
  const guard = installNetworkGuard()
  const directory = mkdtempSync(path.join(tmpdir(), 'kept-reconstruct-'))
  const raw = new CatalogStore(path.join(directory, 'library.sqlite'))
  // The catalog worker's interface: every call answers asynchronously.
  const store = Object.fromEntries(STORE_METHODS.map(method => [method, async request => raw.call(method, request)]))
  raw.registerSource(FOLDER)
  raw.registerSource(NAVIDROME)
  raw.ingestScan(snapshot())
  // Two jobs of one cluster may run side by side: the second finds the album changed and is retried. That is not an error.
  const errors = []
  // Runs the handler module in this process.
  const executor = {
    setGate: () => {}, abort: () => {}, close: async () => {},
    run: execute ?? (async (job, { module }) => (await import(module)).default({
      payload: job.payload, checkpoint: job.checkpoint, attempts: job.attempts,
      signal: new AbortController().signal, save: () => {}, rest: async () => {},
    })),
  }
  const worker = new LibraryWorker({ store, classes: [reconstructClass], executorFor: () => executor, policy: new ResourcePolicy(), onError: (error, context) => { if (!context?.retry) errors.push(error.message) } })
  const jobs = createReconstructJobs({ worker, store })
  t.after(async () => {
    await worker.stop()
    guard.restore()
    raw.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const runAll = async () => {
    const { albumIds, ids } = await jobs.enqueuePending({ folders: [] })
    await Promise.all(ids.map(id => worker.waitFor(id)))
    assert.deepEqual(guard.attempts, [], 'an unmocked network request was attempted')
    return albumIds
  }
  const albums = () => raw.listCatalogAlbums({}).albums
  return { raw, store, worker, jobs, errors, runAll, albums }
}

test('an offline job repairs an album without sending anything and granting lookups queues it again', { timeout: JOB_TIMEOUT_MS }, async t => {
  const { raw, worker, runAll, albums, errors } = open(t)
  await worker.start()
  assert.equal(albums().length, 2)

  assert.equal((await runAll()).length, 2)
  assert.equal(albums().length, 1)
  assert.equal(albums()[0].trackCount, TITLES.length)
  const [receipt] = raw.listChangeSets({}).changeSets
  // Authored by the job of the album it was started for, in the name of the route that proposed it.
  assert.equal(receipt.author.kind, 'job')
  assert.match(receipt.author.id, /^reconstruct:album:/)
  assert.equal(receipt.author.route, 'reconstruct.local-tags')
  assert.equal(receipt.verdict.basis, 'deterministic')
  // The surviving album is read again, because it changed. After that nothing is due.
  while ((await runAll()).length) { /* until the queue is empty */ }
  const [album] = albums()
  const attempt = () => raw.reconstruct.reconstructionAttempts({ albumId: album.id }).attempts[0]
  assert.equal(attempt().status, 'resolved')
  assert.deepEqual(attempt().blockedBy, ['online-lookups', 'acoustid'])
  assert.ok(attempt().outcomes.filter(outcome => outcome.stage >= 3).every(outcome => outcome.status === 'not-permitted-by-user'))
  assert.equal(album.year, undefined)

  // Turning consent on queues exactly the albums it had held back.
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), agent: options.headers['User-Agent'] })
    return { ok: true, status: 200, headers: new Headers(), json: async () => (String(url).includes('/release/') ? releaseBody : { releases: [{ id: RELEASE_ID }] }) }
  }
  raw.setConsent({ consent: 'online-lookups', value: 'granted', decidedAt: T0 })
  assert.deepEqual(await runAll(), [album.id])
  assert.ok(requests.length >= 2)
  for (const request of requests) {
    assert.ok(request.url.startsWith('https://musicbrainz.org/ws/2/'))
    assert.equal(request.agent, `Kept/${TEST_APP_VERSION} ( https://github.com/snaha/kept )`)
    // What is sent names the album, never a file or a folder of the user's.
    assert.doesNotMatch(decodeURIComponent(request.url), /flac|folder-a|\/Users\//)
  }
  assert.equal(albums()[0].year, 2001)
  const identified = raw.listChangeSets({}).changeSets[0]
  assert.equal(identified.author.route, 'reconstruct.musicbrainz-search')
  assert.deepEqual(identified.evidence.map(item => [item.evidenceClass, item.sourceId, item.supports]), [['deterministic', 'musicbrainz', true]])
  const [observation] = raw.all('SELECT * FROM observations WHERE source_id=?', 'musicbrainz')
  assert.equal(observation.licence, 'CC0-1.0')
  assert.equal(observation.field, 'musicbrainz.release-group')
  // The year set from it carries the licence of its evidence.
  assert.equal(raw.getAlbum({ albumId: album.id }).album.fields.year.licence, 'CC0-1.0')
  for (const row of raw.all('SELECT body FROM provider_cache')) assert.doesNotMatch(row.body, /tags|genres|rock/)
  assert.doesNotMatch(JSON.stringify(raw.all('SELECT value FROM observations WHERE source_id=?', 'musicbrainz')), /tags|genres|rock/)

  // The next run answers from the cache: no further request.
  const sent = requests.length
  while ((await runAll()).length) { /* until the queue is empty */ }
  assert.equal(requests.length, sent)
  assert.deepEqual(errors, [])
})

test('a merge the user undid is not made again, and a locked album is left alone', { timeout: JOB_TIMEOUT_MS }, async t => {
  const { raw, worker, runAll, albums } = open(t)
  await worker.start()
  while ((await runAll()).length) { /* until the queue is empty */ }
  assert.equal(albums().length, 1)
  const merge = raw.listChangeSets({}).changeSets.find(changeSet => changeSet.operations[0].operation.kind === 'merge-albums')
  assert.equal(raw.undoChangeSet({ id: merge.id, undoneAt: T0 + 1 }).status, 'undone')
  assert.equal(albums().length, 2)
  // The albums changed, so they are read again, and the same proposal is refused as suppressed.
  while ((await runAll()).length) { /* until the queue is empty */ }
  assert.equal(albums().length, 2)
  assert.equal(raw.getChangeSet({ id: merge.id }).changeSet.state, 'suppressed')
  assert.ok(albums().every(album => raw.reconstruct.reconstructionAttempts({ albumId: album.id }).attempts[0].status === 'resolved'))
})

test('interrupting reconstruction retries with withdrawn consent and discards the earlier result', { timeout: JOB_TIMEOUT_MS }, async t => {
  const started = Promise.withResolvers()
  const earlier = Promise.withResolvers()
  const { raw, store, worker, jobs, albums } = open(t, {
    execute: job => {
      const permission = job.payload.cluster.permissions[MUSICBRAINZ_SOURCE_ID].status
      if (permission === 'permitted') {
        started.resolve()
        return earlier.promise
      }
      return { permission, version: job.payload.cluster.version, albumIds: [job.payload.albumId], reused: true }
    },
  })
  raw.setConsent({ consent: 'online-lookups', value: 'granted', decidedAt: T0 })
  await worker.start()
  const [album] = albums()
  const [id] = await worker.enqueue([{ class: RECONSTRUCT_CLASS, subject: album.id, payload: { albumId: album.id } }])
  const result = worker.waitFor(id)
  await started.promise
  raw.setConsent({ consent: 'online-lookups', value: 'denied', decidedAt: T0 + 1 })
  await jobs.interrupt()
  earlier.resolve({ permission: 'permitted' })
  assert.equal((await result).permission, 'not-permitted-by-user')
  assert.equal((await store.getJobs({ ids: [id] })).jobs[0].attempts, 1)
})

test('a result computed on an album that changed meanwhile is dropped and the job runs again', async t => {
  const { raw, store, runAll, albums } = open(t)
  const [first] = albums()
  const cluster = raw.reconstruct.reconstructionCluster({ albumId: first.id })
  const proposal = { key: 'local-tags:0', route: 'local-tags', operations: [{ kind: 'merge-albums', into: cluster.albums[0].id, from: [cluster.albums[1].id] }], evidence: [{ sourceId: FOLDER.id }], dependsOn: [], summary: 'Joined' }
  const result = { status: 'resolved', inputHash: 'x', policy: 'p', outcomes: [], changeSets: [proposal], observations: [], version: cluster.version, albumIds: cluster.albums.map(album => album.id) }
  // The user sets a trait on the album after the cluster was read.
  raw.commitChangeSet({ id: 'change:trait', author: { kind: 'user' }, operations: [{ kind: 'set-field', subject: { kind: 'album', id: first.id }, field: 'trait.energy', value: 50 }], committedAt: T0 + 1 })
  assert.deepEqual(raw.reconstruct.storeReconstruction({ albumId: first.id, result, now: T0 + 2 }).status, 'stale')
  assert.equal(albums().length, 2, 'nothing of the stale result was applied')
  assert.equal(raw.reconstruct.reconstructionAttempts({ albumId: first.id }).attempts.length, 0)
  await assert.rejects(reconstructClass.commit({ payload: { albumId: first.id } }, result, store), /changed while it was being reconstructed/)
  // The same result on the cluster as it is now is applied, and a second delivery of it applies nothing twice.
  const fresh = { ...result, version: raw.version() }
  const stored = raw.reconstruct.storeReconstruction({ albumId: first.id, result: fresh, now: T0 + 3 })
  assert.deepEqual(stored.commits.map(commit => commit.status), ['applied'])
  assert.equal(albums().length, 1)
  const replay = raw.reconstruct.storeReconstruction({ albumId: first.id, result: { ...fresh, version: raw.version() }, now: T0 + 4 })
  assert.equal(replay.commits[0].replayed, true)
  assert.equal(raw.listChangeSets({}).changeSets.filter(changeSet => changeSet.author.kind === 'job').length, 1)
  void runAll
})

test('the worker process publishes one catalog change after storing a repair', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'kept-reconstruct-'))
  const raw = new CatalogStore(path.join(directory, 'library.sqlite'))
  const store = Object.fromEntries(STORE_METHODS.map(method => [method, async request => raw.call(method, request)]))
  raw.registerSource(FOLDER)
  raw.registerSource(NAVIDROME)
  raw.ingestScan(snapshot())
  const errors = []
  const published = []
  const service = createLibraryService({
    store, fork: nodeFork,
    onCatalogChange: () => published.push(raw.listCatalogAlbums({}).albums.length),
    onError: (error, context) => { if (!context?.retry) errors.push(error.message) },
  })
  t.after(async () => { await service.stop(); raw.close(); rmSync(directory, { recursive: true, force: true }) })
  await service.start()
  const { ids } = await service.reconstruct.enqueuePending({ folders: [directory] })
  await Promise.all(ids.map(id => service.worker.waitFor(id)))
  assert.equal(raw.listCatalogAlbums({}).albums.length, 1)
  assert.deepEqual(published, [1])
  assert.deepEqual(errors, [])
})

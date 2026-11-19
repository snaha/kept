import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CatalogStore } from './catalog-store.js'
import { createEmbeddedReader } from './embedded-tags.js'
import { cacheOf, createMusicBrainz } from './musicbrainz.js'
import { FICTION, buildCorpus, catalogGroups, ingest, reconstructAll, scanFolder, scoreGrouping } from './tests/reconstruct-corpus.js'
import { installNetworkGuard } from './tests/network-guard.js'

// The exit criterion of plan phase A4: on the answer-key corpus the ladder joins nothing that the
// key keeps apart. Unresolved albums are acceptable, false merges are not.
// The audio is synthesised with ffmpeg and tagged with invented names, so no library is needed.
// MusicBrainz is answered from a hand-written fixture: the albums are fictional.

const FIXTURE = new URL('./tests/fixtures/musicbrainz-fictional.json', import.meta.url)
const SOURCE_ID = 'folder-corpus'
const T0 = 1000
const RELEASE_ID = '11111111-1111-4111-8111-111111111111'
const hasTool = name => { try { execFileSync(name, ['-version'], { stdio: 'ignore' }); return true } catch { return false } }
const skip = !hasTool('ffmpeg') || !hasTool('ffprobe') ? 'ffmpeg and ffprobe are needed to build the corpus' : false
const share = value => `${Math.round(value * 100)}%`

let corpus, scan, directory
const prepare = async () => {
  if (corpus) return
  directory = mkdtempSync(path.join(tmpdir(), 'kept-corpus-'))
  corpus = await buildCorpus({ directory: path.join(directory, 'music') })
  scan = await scanFolder({ root: corpus.directory, sourceId: SOURCE_ID, observedAt: T0 })
}
test.after(() => { if (directory) rmSync(directory, { recursive: true, force: true }) })

const openCatalog = name => {
  const store = new CatalogStore(path.join(directory, `${name}.sqlite`))
  const pathOf = ingest(store, scan)
  return { store, pathOf, before: catalogGroups(store, pathOf) }
}
const embeddedTools = (cluster, extra) => ({ readEmbedded: track => scan.embedded.get(track.path), ...extra })
const routesOf = runs => {
  const counts = {}
  for (const { result } of runs) for (const outcome of result.outcomes) (counts[outcome.route] ??= {})[outcome.status] = (counts[outcome.route][outcome.status] ?? 0) + 1
  return counts
}
const report = (label, score, runs, store) => {
  const attempts = store.reconstruct.reconstructionAttempts().attempts.filter(attempt => attempt.status !== 'gone')
  const resolved = attempts.filter(attempt => attempt.status === 'resolved').length
  console.log(`${label}: ${score.albumsBefore} albums before, ${score.albumsAfter} after; false merges ${score.falseMerges.length}; `
    + `split groups repaired ${score.repaired.length}/${score.splitBefore.length} (coverage ${share(score.coverage)}), merge precision ${share(score.precision)}; `
    + `whole groups ${score.whole}/${score.groups}; albums resolved ${resolved}/${attempts.length}`)
  console.log(`${label} routes: ${JSON.stringify(routesOf(runs))}`)
}

test('offline, the corpus is repaired from local evidence with no false merge and no outbound request', { skip }, async () => {
  await prepare()
  const guard = installNetworkGuard()
  const { store, pathOf, before } = openCatalog('offline')
  const requests = []
  const refuseFetch = url => {
    requests.push(url)
    throw new Error('The offline corpus attempted a MusicBrainz request')
  }
  try {
    assert.deepEqual(store.getConsent(), { 'online-lookups': 'not-asked', acoustid: 'not-asked', spotify: 'not-asked' })
    // The real client is handed to the ladder: with lookups off it must never be called.
    const runs = await reconstructAll(store, {
      now: T0 + 1,
      tools: cluster => {
        const cache = cacheOf(cluster.cache)
        return embeddedTools(cluster, {
          provider: createMusicBrainz({ cache, fetch: refuseFetch, intervalMs: 0 }),
          cachedProvider: createMusicBrainz({ cache, offline: true }),
        })
      },
    })
    const after = catalogGroups(store, pathOf)
    const score = scoreGrouping(corpus, before, after)
    report('corpus offline', score, runs, store)

    assert.deepEqual(requests, [], 'the offline corpus must not attempt a MusicBrainz request')
    assert.deepEqual(guard.attempts, [], 'nothing left this machine')
    assert.deepEqual(score.falseMerges, [], 'no album holds files the key keeps apart')
    assert.equal(store.verifyProjections().consistent, true)

    // Purely local albums are rebuilt: the ones the scanner split are whole again.
    for (const name of ['inconsistent-artist', 'split-discs', 'compilation', 'partial-album-tag']) assert.ok(score.repaired.includes(name), `${name} is one album again`)
    const albumOf = file => after.find(album => album.tracks.some(track => track.path === file))
    const groupFiles = name => corpus.groups.find(group => group.name === name).files
    // Field repairs happen offline too: numbers from file names, titles without a file extension, disc numbers.
    const numbered = albumOf(groupFiles('mis-numbered')[0])
    assert.deepEqual(numbered.tracks.map(track => track.track), numbered.tracks.map(track => Number(path.basename(track.path).slice(0, 2))))
    assert.ok(albumOf(groupFiles('inconsistent-artist')[0]).tracks.every(track => !/\.mp3$/i.test(track.title)))
    const discs = albumOf(groupFiles('split-discs')[0])
    assert.equal(discs.title, FICTION.discs.album)
    assert.deepEqual([...new Set(discs.tracks.map(track => track.disc))], [1, 2])
    assert.equal(albumOf(groupFiles('compilation')[0]).artist, 'Various Artists')

    // Editions stay unknown: every online route of every album says who held it back.
    const attempts = store.reconstruct.reconstructionAttempts().attempts.filter(attempt => attempt.status !== 'gone')
    for (const attempt of attempts) {
      const online = attempt.outcomes.filter(outcome => ['provider-cache', 'musicbrainz-ids', 'musicbrainz-search', 'acoustid'].includes(outcome.route))
      assert.ok(online.length > 0 && online.every(outcome => outcome.status === 'not-permitted-by-user'), `the online routes of ${attempt.albumId} were not permitted`)
      assert.ok(attempt.blockedBy.includes('online-lookups'))
    }
    assert.equal(store.all('SELECT count(*) AS total FROM provider_links WHERE source_id=?', 'musicbrainz')[0].total, 0)
    assert.equal(store.all('SELECT count(*) AS total FROM observations WHERE source_id=?', 'musicbrainz')[0].total, 0)

    // Every change went through the ledger, authored by its route, on deterministic evidence.
    const { changeSets } = store.listChangeSets({ limit: 200 })
    assert.ok(changeSets.length > 0)
    for (const changeSet of changeSets) {
      assert.equal(changeSet.author.kind, 'job')
      assert.match(changeSet.author.route, /^reconstruct\.(local-tags|folder-structure)$/)
      assert.equal(changeSet.verdict.basis, 'deterministic')
      assert.ok(changeSet.evidence.length > 0 && changeSet.evidence.every(item => item.evidenceClass === 'deterministic' && item.supports))
    }
    // A second pass finds nothing to do.
    assert.deepEqual(store.reconstruct.reconstructionQueue({}).albumIds, [])
  } finally {
    guard.restore()
    store.close()
  }
})

test('with lookups on, MusicBrainz fixture answers identify albums and still merge nothing wrongly', { skip }, async () => {
  await prepare()
  const guard = installNetworkGuard()
  const { store, pathOf, before } = openCatalog('online')
  const answers = cacheOf(JSON.parse(readFileSync(FIXTURE, 'utf8')))
  try {
    store.setConsent({ consent: 'online-lookups', value: 'granted', decidedAt: T0 })
    // Replay: the fixture's answers stand in for the network, and a question the fixture does not answer is a miss.
    const runs = await reconstructAll(store, {
      now: T0 + 1,
      tools: cluster => embeddedTools(cluster, { provider: createMusicBrainz({ cache: answers, offline: true }), cachedProvider: createMusicBrainz({ cache: cacheOf(cluster.cache), offline: true }) }),
    })
    const after = catalogGroups(store, pathOf)
    const score = scoreGrouping(corpus, before, after)
    report('corpus online', score, runs, store)
    assert.deepEqual(guard.attempts, [], 'the replay sent nothing')
    assert.deepEqual(score.falseMerges, [], 'no album holds files the key keeps apart')
    assert.equal(store.verifyProjections().consistent, true)

    // The album with no album tag is named by its tracklist.
    const untitled = after.find(album => album.tracks.some(track => track.path.startsWith('missing-album/')))
    assert.equal(untitled.title, FICTION.untitled.album)
    // What MusicBrainz said is kept as CC0 observations, and nothing of it is a tag or a genre.
    const observations = store.all('SELECT field, licence, evidence_class, value FROM observations WHERE source_id=?', 'musicbrainz')
    assert.ok(observations.length > 0)
    for (const observation of observations) {
      assert.equal(observation.licence, 'CC0-1.0')
      assert.equal(observation.evidence_class, 'deterministic')
      assert.doesNotMatch(observation.value, /"(tags|genres|rating)"/)
    }
    for (const row of store.all('SELECT body FROM provider_cache')) assert.doesNotMatch(row.body, /"(tags|genres|rating)"/)
    const identified = store.listChangeSets({ limit: 200 }).changeSets.filter(changeSet => /^reconstruct\.(provider-cache|musicbrainz-)/.test(changeSet.author.route))
    assert.ok(identified.length > 0)
    assert.ok(identified.every(changeSet => changeSet.evidence.every(item => item.sourceId === 'musicbrainz' && item.observationId !== undefined)))
  } finally {
    guard.restore()
    store.close()
  }
})

test('the embedded reader finds the MusicBrainz release a file names', { skip }, async t => {
  await prepare()
  const reader = await createEmbeddedReader()
  if (!reader) { t.skip('Tagsmith is not installed beside the app'); return }
  const source = path.join(corpus.directory, ...corpus.groups[0].files[0].split('/'))
  const tagged = path.join(directory, 'tagged.mp3')
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', source, '-c', 'copy', '-metadata', `MusicBrainz Album Id=${RELEASE_ID}`, '-metadata', 'album_artist=Various Artists', '-id3v2_version', '3', tagged])
  assert.deepEqual(await reader(tagged), { releaseId: RELEASE_ID, recordingId: undefined, releaseGroupId: undefined, compilation: undefined, albumArtist: 'Various Artists' })
  assert.equal((await reader(source)).releaseId, undefined)
  assert.equal(await reader(path.join(directory, 'missing.mp3')), undefined)
})

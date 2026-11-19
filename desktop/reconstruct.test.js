import test from 'node:test'
import assert from 'node:assert/strict'
import { validateCatalogChange } from '../shared/catalog-rules.js'
import { LADDER_POLICY, MUSICBRAINZ_SOURCE, ACOUSTID_SOURCE, ROUTES, ROUTE_STATUSES, runLadder } from '../shared/reconstruct.js'
import { PAIR_MARGIN, assignTracks, chooseRelease, cleanTitle, discOfTitle, evaluateRelease, hungarian, parseFileName, sameArtist, similarity } from '../shared/reconstruct-match.js'
import { MIN_INTERVAL_MS, cacheOf, createMusicBrainz, reduceRelease } from './musicbrainz.js'

const SECOND = 1000
const LENGTH = 200
const SEARCH_REQUESTS = 3
const CLIENT_BUDGET = 4
const RELEASE_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_RELEASE_ID = '22222222-2222-4222-8222-222222222222'
const GROUP_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_GROUP_ID = '44444444-4444-4444-8444-444444444444'
const TITLES = ['Harbour Lights', 'Paper Lanterns', 'Salt and Iron', 'The Long Way Down', 'Quiet Machines']
const permitted = { status: 'permitted' }
const denied = consent => ({ status: 'not-permitted-by-user', consent })
const offline = { musicbrainz: denied('online-lookups'), acoustid: denied('acoustid') }
const online = { musicbrainz: permitted, acoustid: denied('acoustid') }

const release = (overrides = {}) => ({
  id: RELEASE_ID, title: 'Tidewater', artist: 'The Band', date: '2001-03-04', releaseGroupId: GROUP_ID, firstReleaseDate: '2001',
  media: [{ position: 1, tracks: TITLES.map((title, index) => ({ position: index + 1, title, length: (LENGTH + index * 10) * SECOND, recordingId: `rec-${index + 1}` })) }],
  ...overrides,
})
// One album of five numbered tracks in one folder, as the catalog would describe it.
const cluster = (overrides = {}) => {
  const album = { id: 'album:a', seq: 1, title: 'Tidewater', artist: 'The Band', year: 2001, locks: [], userFields: [], links: [], evidence: { title: 'obs:title' } }
  const tracks = TITLES.map((title, index) => ({
    assetId: `asset:${index + 1}`, albumId: 'album:a', track: index + 1, sourceId: 'folder-a', path: `The Band - Tidewater/${String(index + 1).padStart(2, '0')} - ${title}.flac`,
    available: true, title, artist: 'The Band', duration: LENGTH + index * 10, locks: [], userFields: [], evidence: {},
  }))
  return { seed: 'album:a', version: 1, permissions: offline, albums: [album], tracks, cache: [], ...overrides }
}
// A provider that answers from fixed data and counts what it was asked.
const fakeProvider = ({ releases = [release()], search = releases.map(item => item.id), fail } = {}) => {
  const calls = []
  const ask = (kind, value) => { calls.push(kind); if (fail) throw fail; return value }
  return {
    calls, requests: () => calls.length,
    release: async id => ask('release', releases.find(item => item.id === id)),
    searchReleases: async () => ask('search-release', search),
    searchRecordings: async () => ask('search-recording', search),
  }
}
const outcome = (result, route) => result.outcomes.find(item => item.route === route)
const operations = result => result.changeSets.flatMap(changeSet => changeSet.operations)

test('text keys compare names the way people type them', () => {
  assert.ok(sameArtist('Glass Orchard', 'GlassOrchard'))
  assert.ok(sameArtist('Glass Orchard feat. Ivo Brandt', 'Glass Orchard'))
  assert.ok(!sameArtist('DJ Kestrel', 'Mara Vale'))
  assert.ok(similarity('Where The Tide Turns', 'Where The Tide Turns So Slow?', true) >= 0.9)
  assert.equal(cleanTitle('Lanternlight.mp3'), 'Lanternlight')
  assert.equal(cleanTitle('Lanternlight'), undefined)
  assert.deepEqual(discOfTitle('Play (Disc 2)'), { title: 'Play', disc: 2 })
  assert.equal(discOfTitle('Play'), undefined)
  assert.deepEqual(parseFileName('07 - Paper Boats.mp3'), { track: 7, stem: 'Paper Boats' })
  // A band whose name starts with a number is not a track number.
  assert.equal(parseFileName('2 Unlimited - No Limit.mp3').track, undefined)
})

test('the assignment is one-to-one and is not forced by a greedy first pick', () => {
  assert.deepEqual(hungarian([[4, 1, 3], [2, 0, 5], [3, 2, 2]]), [1, 0, 2])
  // Greedy would give 'Intro' to the first slot it fits and leave the reprise with a worse one.
  const slots = [{ disc: 1, position: 1, title: 'Intro', duration: 60 }, { disc: 1, position: 2, title: 'Intro', duration: 95 }, { disc: 1, position: 3, title: 'Outro', duration: 120 }]
  const locals = [{ id: 'a', title: 'Intro', duration: 94 }, { id: 'b', title: 'Intro', duration: 61 }, { id: 'c', title: 'Something Else', duration: 120 }]
  const { pairs, unmatched, unused } = assignTracks(locals, slots)
  assert.deepEqual(pairs.map(pair => [pair.id, pair.slot]), [['a', 1], ['b', 0]])
  assert.deepEqual(unmatched, ['c'])
  assert.deepEqual(unused, [2])
  assert.ok(pairs.every(pair => !pair.ambiguous && pair.margin >= PAIR_MARGIN))
})

test('two files that fit one slot equally well are ambiguous, and a live take is not the studio one', () => {
  const slots = [{ disc: 1, position: 1, title: 'Harbour Lights', duration: 200 }]
  const twins = assignTracks([{ id: 'a', title: 'Harbour Lights', duration: 200 }, { id: 'b', title: 'Harbour Lights', duration: 200 }], slots)
  assert.equal(twins.pairs.length, 1)
  assert.equal(twins.pairs[0].ambiguous, true)
  assert.deepEqual(assignTracks([{ id: 'a', title: 'Harbour Lights (live)', duration: 200 }], slots).unmatched, ['a'])
  // The same title at another length is another take.
  assert.deepEqual(assignTracks([{ id: 'a', title: 'Harbour Lights', duration: 400 }], slots).unmatched, ['a'])
  // A recording ID settles it whatever the tags say.
  const identified = assignTracks([{ id: 'a', title: 'Track 01', recordingId: 'rec-1' }], [{ ...slots[0], recordingId: 'rec-1' }])
  assert.equal(identified.pairs[0].score, 1)
})

test('the release policy accepts a covered album and names what it vetoes', () => {
  const locals = cluster().tracks.map(track => ({ id: track.assetId, title: track.title, duration: track.duration, track: track.track }))
  const accepted = evaluateRelease({ title: 'Tidewater', artist: 'The Band', tracks: locals }, release())
  assert.equal(accepted.accepted, true)
  assert.equal(accepted.matched, TITLES.length)
  assert.deepEqual(evaluateRelease({ title: 'Tidewater', artist: 'Somebody Else', tracks: locals }, release()).vetoes, ['artist'])
  assert.deepEqual(evaluateRelease({ title: 'Tidewater', artist: 'The Band', tracks: locals.slice(0, 2) }, release()).vetoes, ['too-few-tracks'])
  const strangers = locals.map((local, index) => (index < 2 ? local : { ...local, title: `Unrelated ${index}` }))
  assert.ok(evaluateRelease({ title: 'Tidewater', artist: 'The Band', tracks: strangers }, release()).vetoes.includes('coverage'))
  // Without an album title, a box set that merely holds the files is not their album.
  const boxSet = release({ media: [release().media[0], { position: 2, tracks: Array.from({ length: 12 }, (_, index) => ({ position: index + 1, title: `Extra ${index}`, length: 0 })) }] })
  assert.deepEqual(evaluateRelease({ artist: 'The Band', tracks: locals }, boxSet).vetoes, ['completeness'])
})

test('editions of one release group are one answer, and two release groups that fit alike are none', () => {
  const locals = cluster().tracks.map(track => ({ id: track.assetId, title: track.title, duration: track.duration, track: track.track }))
  const target = { title: 'Tidewater', artist: 'The Band', tracks: locals }
  const reissue = release({ id: OTHER_RELEASE_ID })
  const sameGroup = chooseRelease([evaluateRelease(target, release()), evaluateRelease(target, reissue)])
  assert.equal(sameGroup.status, 'matched')
  assert.equal(sameGroup.editions.length, 2)
  const otherGroup = chooseRelease([evaluateRelease(target, release()), evaluateRelease(target, { ...reissue, releaseGroupId: OTHER_GROUP_ID })])
  assert.equal(otherGroup.status, 'ambiguous')
  assert.equal(chooseRelease([evaluateRelease({ ...target, artist: 'Somebody Else' }, release())]).status, 'no-match')
})

test('the routes run in order of cost and every outcome has a known status', async () => {
  assert.deepEqual(ROUTES.map(route => route.stage), [0, 1, 2, 3, 4, 5, 6])
  assert.deepEqual(ROUTES.map(route => route.id), ['decisions', 'local-tags', 'folder-structure', 'provider-cache', 'musicbrainz-ids', 'musicbrainz-search', 'acoustid'])
  const provider = fakeProvider({ search: [] })
  const result = await runLadder(cluster({ permissions: { musicbrainz: permitted, acoustid: permitted } }), { provider, cachedProvider: fakeProvider({ fail: Object.assign(new Error('miss'), { code: 'cache-miss' }) }) })
  assert.deepEqual(result.outcomes.map(item => item.stage), [0, 1, 2, 3, 4, 5, 6])
  for (const item of result.outcomes) {
    assert.ok(ROUTE_STATUSES.includes(item.status))
    assert.equal(item.policy, LADDER_POLICY)
    assert.equal(item.inputHash, result.inputHash)
  }
  assert.equal(outcome(result, 'provider-cache').status, 'no-match')
  assert.equal(outcome(result, 'musicbrainz-ids').status, 'not-applicable')
  assert.equal(outcome(result, 'musicbrainz-search').status, 'no-match')
  // Fingerprinting is opt-in with the user's own key. Permitted but without one, it is unavailable.
  assert.equal(outcome(result, 'acoustid').status, 'unavailable')
  // One search by album, then one for each of two tracks.
  assert.equal(outcome(result, 'musicbrainz-search').requests, SEARCH_REQUESTS)
})

test('with lookups off no provider is called and the online routes say who held them back', async () => {
  const provider = fakeProvider()
  const result = await runLadder(cluster(), { provider, cachedProvider: provider })
  assert.deepEqual(provider.calls, [])
  for (const route of ['provider-cache', 'musicbrainz-ids', 'musicbrainz-search']) assert.deepEqual({ status: outcome(result, route).status, consent: outcome(result, route).consent }, { status: 'not-permitted-by-user', consent: 'online-lookups' })
  assert.equal(outcome(result, 'acoustid').consent, 'acoustid')
  assert.deepEqual(result.blockedBy, ['online-lookups', 'acoustid'])
  // The album is fine as it is: only its edition is unknown, and that is not a defect.
  assert.equal(result.status, 'resolved')
  assert.deepEqual(result.needs, ['edition'])
  assert.deepEqual(result.changeSets, [])
})

test('the ladder stops at the route that supports the album', async () => {
  const provider = fakeProvider()
  const result = await runLadder(cluster({ permissions: online }), { provider, cachedProvider: provider })
  // The cached answer was enough: neither MusicBrainz route nor the fingerprint route ran.
  assert.deepEqual(result.outcomes.map(item => [item.route, item.status]), [['decisions', 'not-applicable'], ['local-tags', 'not-applicable'], ['folder-structure', 'not-applicable'], ['provider-cache', 'succeeded']])
  assert.equal(result.status, 'resolved')
  // The release group is observed as MusicBrainz core data. Its edition is not claimed.
  assert.deepEqual(result.observations.map(item => [item.sourceId, item.field, item.value.id]), [['musicbrainz', 'musicbrainz.release-group', GROUP_ID]])
  assert.ok(!operations(result).some(operation => operation.kind === 'relink-provider'))
})

test('an embedded release ID identifies the edition, and files that carry it are one album', async () => {
  const base = cluster({ permissions: online })
  const tracks = base.tracks.map((track, index) => ({ ...track, albumId: index < 3 ? 'album:a' : 'album:b', track: undefined, title: index === 4 ? undefined : track.title }))
  const albums = [base.albums[0], { ...base.albums[0], id: 'album:b', seq: 2, title: 'Tidewater (bonus)', artist: 'Band, The' }]
  const provider = fakeProvider()
  const result = await runLadder({ ...base, albums, tracks }, {
    provider, cachedProvider: fakeProvider({ fail: Object.assign(new Error('miss'), { code: 'cache-miss' }) }),
    readEmbedded: track => ({ releaseId: RELEASE_ID, recordingId: `rec-${track.assetId.split(':')[1]}` }),
  })
  assert.equal(outcome(result, 'local-tags').status, 'succeeded')
  assert.equal(outcome(result, 'musicbrainz-ids').status, 'succeeded')
  assert.equal(outcome(result, 'musicbrainz-search'), undefined)
  const all = operations(result)
  assert.deepEqual(all.find(operation => operation.kind === 'merge-albums'), { kind: 'merge-albums', into: 'album:a', from: ['album:b'] })
  assert.deepEqual(all.find(operation => operation.kind === 'relink-provider'), { kind: 'relink-provider', sourceId: 'musicbrainz', linkKind: 'album', externalId: RELEASE_ID, subject: { kind: 'album', id: 'album:a' } })
  // Missing numbers and a missing title come from the release. Recording IDs carry the match.
  assert.deepEqual(all.filter(operation => operation.kind === 'move-track' && operation.track !== undefined).map(operation => operation.track), [1, 2, 3, 4, 5])
  assert.deepEqual(all.find(operation => operation.kind === 'set-field' && operation.subject.kind === 'asset'), { kind: 'set-field', subject: { kind: 'asset', id: 'asset:5' }, field: 'title', value: 'Quiet Machines' })
  assert.equal(result.observations[0].field, 'musicbrainz.release')
  // The identifying change set rests on the stored observation and builds on nothing it did not commit.
  const identified = result.changeSets.at(-1)
  assert.deepEqual(identified.evidence, [{ observation: result.observations[0].key }])
})

test('embedded release IDs that disagree stay visible and decide nothing', async () => {
  const provider = fakeProvider({ search: [] })
  const result = await runLadder(cluster({ permissions: online }), {
    provider, cachedProvider: provider, readEmbedded: track => ({ releaseId: track.track % 2 ? RELEASE_ID : OTHER_RELEASE_ID }),
  })
  assert.deepEqual({ status: outcome(result, 'musicbrainz-ids').status, detail: outcome(result, 'musicbrainz-ids').detail }, { status: 'ambiguous', detail: 'embedded-releases-disagree' })
  assert.ok(!operations(result).some(operation => operation.kind === 'relink-provider'))
})

test('a failed or over-budget lookup is retryable or deferred, never a negative answer', async () => {
  const cacheMiss = fakeProvider({ fail: Object.assign(new Error('miss'), { code: 'cache-miss' }) })
  const down = await runLadder(cluster({ permissions: online }), { provider: fakeProvider({ fail: Object.assign(new Error('MusicBrainz could not be reached'), { code: 'network' }) }), cachedProvider: cacheMiss })
  assert.equal(outcome(down, 'musicbrainz-search').status, 'retryable-failure')
  assert.equal(down.retry, true)
  const spent = await runLadder(cluster({ permissions: online }), { provider: fakeProvider({ fail: Object.assign(new Error('budget'), { code: 'budget' }) }), cachedProvider: cacheMiss })
  assert.equal(outcome(spent, 'musicbrainz-search').status, 'deferred')
  assert.equal(spent.retry, true)
  const missing = await runLadder(cluster({ permissions: online }), { cachedProvider: cacheMiss })
  assert.equal(outcome(missing, 'musicbrainz-search').status, 'unavailable')
})

test('locks and the user\'s own values are left alone, and an answer on unchanged input is reused', async () => {
  const base = cluster()
  const split = { ...base, albums: [base.albums[0], { ...base.albums[0], id: 'album:b', seq: 2, artist: 'TheBand', locks: ['tracks'] }], tracks: base.tracks.map((track, index) => ({ ...track, albumId: index < 3 ? 'album:a' : 'album:b' })) }
  const locked = await runLadder(split)
  assert.equal(outcome(locked, 'local-tags').detail, 'membership-locked')
  assert.deepEqual(locked.changeSets, [])
  const free = await runLadder({ ...split, albums: split.albums.map(album => ({ ...album, locks: [] })) })
  assert.deepEqual(operations(free), [{ kind: 'merge-albums', into: 'album:a', from: ['album:b'] }])

  const junk = { ...base, tracks: base.tracks.map((track, index) => ({ ...track, title: `${track.title}.mp3`, userFields: index === 0 ? ['title'] : [] })) }
  const cleaned = operations(await runLadder(junk))
  assert.equal(cleaned.length, TITLES.length - 1)
  assert.ok(!cleaned.some(operation => operation.subject.id === 'asset:1'))

  const first = await runLadder(base)
  const again = await runLadder({ ...base, previous: { inputHash: first.inputHash, policy: first.policy, status: first.status, online: false, retry: false } })
  assert.deepEqual(again.outcomes.map(item => [item.route, item.status]), [['decisions', 'succeeded']])
  assert.equal(again.reused, true)
  // Consent granted since: the old answer no longer stands.
  const granted = await runLadder({ ...base, permissions: online, previous: { inputHash: first.inputHash, policy: first.policy, status: first.status, online: false, retry: false } }, { provider: fakeProvider(), cachedProvider: fakeProvider() })
  assert.notEqual(granted.reused, true)
})

test('only deterministic and user evidence approve what the ladder proposes', () => {
  assert.equal(MUSICBRAINZ_SOURCE.evidenceClass, 'deterministic')
  assert.equal(MUSICBRAINZ_SOURCE.licence, 'CC0-1.0')
  assert.equal(MUSICBRAINZ_SOURCE.policy.consent, 'online-lookups')
  assert.equal(ACOUSTID_SOURCE.licence, 'non-commercial')
  assert.equal(ACOUSTID_SOURCE.policy.consent, 'acoustid')
  assert.deepEqual(validateCatalogChange({ evidence: [{ evidenceClass: 'deterministic', supports: true }] }), { approvable: true, basis: 'deterministic' })
  assert.deepEqual(validateCatalogChange({ evidence: [{ evidenceClass: 'model', supports: true }] }), { approvable: false, reason: 'model-only' })
})

test('the MusicBrainz client paces requests, names no person and keeps core data only', async () => {
  const requests = [], waits = []
  let clock = 0
  const body = {
    id: RELEASE_ID, title: 'Tidewater', date: '2001', status: 'Official', tags: [{ name: 'rock', count: 3 }], genres: [{ name: 'rock' }], rating: { value: 4 },
    'artist-credit': [{ name: 'The Band', joinphrase: '', artist: { id: 'x', tags: [{ name: 'folk' }], genres: [{ name: 'folk' }] } }],
    'release-group': { id: GROUP_ID, 'first-release-date': '2001', genres: [{ name: 'rock' }], tags: [{ name: 'rock' }] },
    media: [{ position: 1, tracks: [{ position: 1, title: 'Harbour Lights', length: 200000, recording: { id: 'rec-1', tags: [{ name: 'rock' }], genres: [] } }] }],
  }
  const fetch = async (url, options) => {
    requests.push({ url, headers: options.headers, at: clock })
    return { ok: true, status: 200, json: async () => (url.includes('/release/') ? body : { releases: [{ id: RELEASE_ID, tags: [{ name: 'rock' }] }] }) }
  }
  const client = createMusicBrainz({ fetch, now: () => clock, sleep: async ms => { waits.push(ms); clock += ms }, budget: CLIENT_BUDGET })
  assert.deepEqual(await client.searchReleases({ title: 'Tide/water: "live"', artist: 'The Band' }), [RELEASE_ID])
  const found = await client.release(RELEASE_ID)
  await client.release(RELEASE_ID)
  assert.equal(client.requests(), 2, 'the second lookup of a release is answered from the cache')
  assert.ok(requests[1].at - requests[0].at >= MIN_INTERVAL_MS, 'at most one request a second')
  for (const request of requests) {
    assert.ok(request.url.startsWith('https://musicbrainz.org/ws/2/'))
    assert.match(request.headers['User-Agent'], /^Kept\/[\d.]+ \( https:\/\/github\.com\/snaha\/kept \)$/)
    assert.doesNotMatch(request.url, /inc=[^&]*(tags|genres|ratings)/)
  }
  // Tags and genres are CC BY-NC-SA: whatever the service sends, none of it is kept.
  assert.doesNotMatch(JSON.stringify([found, client.fresh()]), /tags|genres|rating|rock|folk/)
  assert.deepEqual(found, reduceRelease(body))
  assert.equal(found.media[0].tracks[0].recordingId, 'rec-1')
  // Nothing under the exact words, so the search is repeated one letter off: two more requests.
  assert.deepEqual(await client.searchRecordings({ title: 'Harbour Lights', artist: 'The Band' }), [])
  await assert.rejects(client.release(OTHER_RELEASE_ID), { code: 'budget' })
  // Offline it answers from the cache and refuses anything else without touching the network.
  const cached = createMusicBrainz({ cache: cacheOf(client.fresh()), offline: true, fetch: () => { throw new Error('the network was used') } })
  assert.equal((await cached.release(RELEASE_ID)).title, 'Tidewater')
  await assert.rejects(cached.release(OTHER_RELEASE_ID), { code: 'cache-miss' })
  assert.equal(await createMusicBrainz({ fetch, offline: true }).release('not-an-id'), undefined)
})

test('an aborted MusicBrainz request does not start after waiting for its turn', async () => {
  const controller = new AbortController()
  const waiting = Promise.withResolvers()
  const resume = Promise.withResolvers()
  const at = Date.now()
  const HTTP_NOT_FOUND = 404
  const requests = []
  const client = createMusicBrainz({
    now: () => at,
    signal: controller.signal,
    sleep: () => {
      waiting.resolve()
      return resume.promise
    },
    fetch: async url => {
      requests.push(url)
      return { ok: false, status: HTTP_NOT_FOUND }
    },
  })
  await client.release(RELEASE_ID)
  const next = client.release(OTHER_RELEASE_ID)
  await waiting.promise
  controller.abort()
  resume.resolve()
  await assert.rejects(next, { code: 'aborted' })
  assert.equal(requests.length, 1)
})

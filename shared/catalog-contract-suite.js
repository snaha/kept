// The behaviour every CatalogService must share. The fake passes it today and the
// SQLite service must pass it unchanged. Types: catalog-contract-suite.d.ts.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createCatalogBridge } from './catalog-bridge.js'
import { ID_PATTERN, USER_SOURCE_ID, routeSource } from './catalog-rules.js'

const T1 = 1000, T2 = 2000, T3 = 3000, T4 = 4000, T5 = 5000
const YEAR = 1959, OTHER_YEAR = 1997
const SIZE = 4096
const ENERGY = 80, ESTIMATED_ENERGY = 35, NEWER_ESTIMATE = 40, OUT_OF_RANGE = 101
const policy = { analysisAllowed: true, network: 'none' }
const folder = { id: 'folder-a', kind: 'local-folder', label: 'Music', evidenceClass: 'deterministic', licence: 'user', policy }
const navidrome = { id: 'navidrome', kind: 'navidrome', label: 'Navidrome', evidenceClass: 'deterministic', licence: 'user', policy: { analysisAllowed: true, network: 'lan' } }
const model = { id: 'openl3', kind: 'model', label: 'OpenL3', evidenceClass: 'model', licence: 'CC-BY-4.0', policy }
const musicbrainz = { id: 'musicbrainz', kind: 'musicbrainz', label: 'MusicBrainz', evidenceClass: 'deterministic', licence: 'CC0-1.0', policy: { analysisAllowed: false, network: 'internet', consent: 'online-lookups' } }
const mbTags = { ...musicbrainz, id: 'musicbrainz-tags', licence: 'CC-BY-NC-SA-3.0' }
const file = (name, albumId, track, trackId = `nd-${name}`) => ({ path: `Artist/Album/${name}.flac`, contentHash: `hash-${name}`, size: SIZE, track, providerTrackId: trackId, providerAlbumId: albumId })
const scan = (files, extra = {}) => ({ sourceId: folder.id, providerSourceId: navidrome.id, observedAt: T1, rootAvailable: true, complete: true, files, ...extra })

export function runCatalogContractSuite(label, createService) {
  const run = (name, body) => test(`${label}: ${name}`, async () => {
    const { service, dispose, restart } = await createService()
    try { await body(service, async () => (restart ? restart() : service)) } finally { await dispose?.() }
  })
  // One album of two tracks, scanned from a folder through Navidrome.
  const seed = async service => {
    await service.registerSource(folder)
    await service.registerSource(navidrome)
    const result = await service.ingestScan(scan([file('one', 'nd-album', 1), file('two', 'nd-album', 2)]))
    return { result, albumId: result.albumIds[0], album: { kind: 'album', id: result.albumIds[0] } }
  }

  run('answers with plain JSON and opaque IDs', async service => {
    const { result, albumId } = await seed(service)
    const { album } = await service.getAlbum({ albumId })
    const { asset } = await service.getAsset({ assetId: result.assetIds[0] })
    for (const value of [result, album, asset, await service.listSources(), await service.getConsent()]) assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
    for (const id of [albumId, ...result.assetIds, ...album.tracks.map(track => track.id)]) assert.match(id, ID_PATTERN)
    assert.deepEqual(await service.getAlbum({ albumId: 'album-none' }), {})
    assert.deepEqual(await service.getAsset({ assetId: 'asset-none' }), {})
  })

  run('registers sources, updates policy and keeps identity fixed', async service => {
    const created = await service.registerSource(folder)
    assert.deepEqual(created, { ...folder, consentState: 'not-required' })
    const updated = await service.registerSource({ ...folder, label: 'Archive', policy: { ...policy, analysisAllowed: false } })
    assert.equal(updated.label, 'Archive')
    assert.equal(updated.policy.analysisAllowed, false)
    const { sources } = await service.listSources()
    assert.deepEqual(sources.map(source => source.id).sort(), [folder.id, USER_SOURCE_ID])
    assert.equal(sources.find(source => source.id === USER_SOURCE_ID).evidenceClass, 'user')
    await assert.rejects(service.registerSource({ ...folder, licence: 'MIT' }), /^Error: source-identity-immutable:/)
    await assert.rejects(service.registerSource({ ...model, evidenceClass: 'deterministic' }), /^Error: invalid-source:/)
    await assert.rejects(service.registerSource({ ...musicbrainz, policy: { analysisAllowed: false, network: 'internet' } }), /^Error: invalid-source:/)
    await assert.rejects(service.registerSource({ ...folder, id: 'spotify', kind: 'spotify', licence: 'proprietary' }), /^Error: invalid-source:/)
    await assert.rejects(service.registerSource({ ...folder, id: '/Users/me/Music' }), /^Error: invalid-source:/)
  })

  run('keeps online sources off until the user consents', async service => {
    assert.deepEqual(await service.getConsent(), { 'online-lookups': 'not-asked', acoustid: 'not-asked', spotify: 'not-asked' })
    const source = await service.registerSource(musicbrainz)
    assert.equal(source.consentState, 'not-asked')
    assert.deepEqual(routeSource(source), { status: 'not-permitted-by-user', consent: 'online-lookups' })
    assert.deepEqual(await service.setConsent({ consent: 'online-lookups', value: 'granted', decidedAt: T1 }), { 'online-lookups': 'granted', acoustid: 'not-asked', spotify: 'not-asked' })
    const [granted] = (await service.listSources()).sources.filter(item => item.id === musicbrainz.id)
    assert.deepEqual(routeSource(granted), { status: 'permitted' })
    const decision = await service.recordUserDecision({ kind: 'consent', consent: 'online-lookups', value: 'denied', decidedAt: T2 })
    assert.equal(decision.sourceId, USER_SOURCE_ID)
    assert.equal((await service.getConsent())['online-lookups'], 'denied')
    const [denied] = (await service.listSources()).sources.filter(item => item.id === musicbrainz.id)
    assert.equal(routeSource(denied).status, 'not-permitted-by-user')
    await assert.rejects(service.setConsent({ consent: 'everything', value: 'granted', decidedAt: T3 }), /^Error: invalid-request:/)
  })

  run('ingests a scan into assets, locations, occurrences and an anchor', async service => {
    const { result, albumId } = await seed(service)
    assert.equal(result.assetIds.length, 2)
    assert.deepEqual(result.conflicts, [])
    const { album } = await service.getAlbum({ albumId })
    assert.deepEqual(album.tracks.map(track => [track.assetId, track.position, track.track]), [[result.assetIds[0], 0, 1], [result.assetIds[1], 1, 2]])
    assert.equal(album.availability, 'available')
    assert.equal(album.favorite, false)
    const { asset } = await service.getAsset({ assetId: result.assetIds[0] })
    assert.equal(asset.albumId, albumId)
    assert.equal(asset.contentHash, 'hash-one')
    assert.equal(asset.analysisAllowed, true)
    assert.deepEqual(asset.locations, [{ assetId: asset.id, sourceId: folder.id, path: 'Artist/Album/one.flac', availability: 'available', seenAt: T1 }])
    assert.deepEqual(await service.listAlbums({}), { albums: [album], total: 1 })
    assert.deepEqual(await service.listAlbums({ offset: 1, limit: 1 }), { albums: [], total: 1 })
    await assert.rejects(service.ingestScan(scan([], { sourceId: 'folder-none' })), /^Error: unknown-source:/)
    await assert.rejects(service.ingestScan(scan([{ ...file('bad', 'nd-album', 1), size: -1 }])), /^Error: invalid-request:/)
  })

  run('a re-scan is idempotent and a moved file keeps its asset', async service => {
    const { result, albumId } = await seed(service)
    const again = await service.ingestScan(scan([file('one', 'nd-album', 1), file('two', 'nd-album', 2)], { observedAt: T2 }))
    assert.deepEqual(again, result)
    const moved = { ...file('one', 'nd-album', 1), path: 'Sorted/one.flac' }
    const after = await service.ingestScan(scan([moved, file('two', 'nd-album', 2)], { observedAt: T3 }))
    assert.deepEqual(after.assetIds, result.assetIds)
    const { asset } = await service.getAsset({ assetId: result.assetIds[0] })
    assert.equal(asset.albumId, albumId)
    assert.equal(asset.availability, 'available')
    assert.deepEqual(asset.locations.map(location => [location.path, location.availability]).sort(), [['Artist/Album/one.flac', 'missing'], ['Sorted/one.flac', 'available']])
    assert.equal((await service.listAlbums({})).total, 1)
  })

  run('an offline folder is unavailable, not deleted, and comes back', async service => {
    const { result, albumId, album } = await seed(service)
    await service.recordUserDecision({ kind: 'trait', subject: album, trait: 'energy', value: ENERGY, decidedAt: T1 })
    assert.deepEqual(await service.ingestScan(scan([], { rootAvailable: false, observedAt: T2 })), { assetIds: [], albumIds: [], conflicts: [] })
    const offline = (await service.getAlbum({ albumId })).album
    assert.equal(offline.availability, 'unavailable')
    assert.equal(offline.tracks.length, 2)
    assert.equal(offline.traits.energy.value, ENERGY)
    assert.equal((await service.getAsset({ assetId: result.assetIds[0] })).asset.availability, 'unavailable')
    await service.ingestScan(scan([file('one', 'nd-album', 1)], { complete: false, observedAt: T3 }))
    assert.equal((await service.getAlbum({ albumId })).album.availability, 'partial')
    await service.ingestScan(scan([file('one', 'nd-album', 1)], { observedAt: T4 }))
    assert.equal((await service.getAsset({ assetId: result.assetIds[1] })).asset.availability, 'missing')
    assert.equal((await service.getAlbum({ albumId })).album.tracks.length, 2)
  })

  run('when one copy goes offline, the projection and history use the surviving stream', async service => {
    const { result, albumId } = await seed(service)
    const [assetId] = result.assetIds
    const archive = { ...folder, id: 'folder-z', label: 'Archive' }
    const original = file('one', 'nd-album', 1)
    const duplicate = { ...original, providerTrackId: 'nd-a-archive' }
    await service.registerSource(archive)
    await service.ingestScan(scan([duplicate], { sourceId: archive.id, observedAt: T2 }))
    const read = async () => (await service.getCatalogAlbum({ albumId })).album
    const before = await read()
    assert.equal(before.tracks[0].links.length, 2)
    await service.ingestScan(scan([], { sourceId: archive.id, rootAvailable: false, observedAt: T3 }))
    await service.ingestScan(scan([original, file('two', 'nd-album', 2)], { observedAt: T4 }))
    const after = await read()
    assert.equal(after.tracks[0].availability, 'available')
    const links = [{ sourceId: navidrome.id, externalId: original.providerTrackId }]
    assert.deepEqual(after.tracks[0].links, links)
    assert.ok(after.version > before.version)
    assert.deepEqual(await createCatalogBridge(service).playbackLinks({ assetIds: [assetId] }), {
      links: { [assetId]: links }, version: after.version,
    })
  })

  run('a provider re-ID keeps the anchor, its traits and its favourite', async service => {
    const { result, albumId, album } = await seed(service)
    await service.recordUserDecision({ kind: 'trait', subject: album, trait: 'energy', value: ENERGY, decidedAt: T1 })
    await service.recordUserDecision({ kind: 'favorite', subject: album, value: true, decidedAt: T1 })
    const reId = await service.ingestScan(scan([file('one', 'nd-album-2', 1, 'nd-one-2'), file('two', 'nd-album-2', 2, 'nd-two-2')], { observedAt: T2 }))
    assert.deepEqual(reId, result)
    for (const externalId of ['nd-album', 'nd-album-2']) {
      assert.deepEqual(await service.resolveProviderId({ sourceId: navidrome.id, kind: 'album', externalId }), { subject: album })
    }
    assert.deepEqual(await service.resolveProviderId({ sourceId: navidrome.id, kind: 'track', externalId: 'nd-one-2' }), { subject: { kind: 'asset', id: result.assetIds[0] } })
    assert.deepEqual(await service.resolveProviderId({ sourceId: navidrome.id, kind: 'album', externalId: 'nd-none' }), {})
    const kept = (await service.getAlbum({ albumId })).album
    assert.equal(kept.traits.energy.value, ENERGY)
    assert.equal(kept.favorite, true)
    assert.equal((await service.listAlbums({})).total, 1)
  })

  run('a scan never merges or splits anchors on its own', async service => {
    const { result, albumId } = await seed(service)
    const other = await service.ingestScan(scan([file('three', 'nd-other', 1)], { complete: false, observedAt: T2 }))
    const [otherAlbumId] = other.albumIds
    assert.notEqual(otherAlbumId, albumId)
    // Navidrome now files track one under the other album, and track two under a new one with a new track.
    const moved = await service.ingestScan(scan([file('one', 'nd-other', 2), file('two', 'nd-new', 1), file('four', 'nd-new', 2), file('three', 'nd-other', 1)], { observedAt: T3 }))
    const [, , fourId] = moved.assetIds
    const newAlbumId = (await service.getAsset({ assetId: fourId })).asset.albumId
    assert.deepEqual(moved.conflicts, [
      { assetId: result.assetIds[0], albumId, providerAlbumId: 'nd-other', linkedAlbumId: otherAlbumId },
      { assetId: result.assetIds[1], albumId, providerAlbumId: 'nd-new', linkedAlbumId: newAlbumId },
    ])
    assert.deepEqual((await service.getAlbum({ albumId })).album.tracks.map(track => track.assetId), result.assetIds)
    assert.deepEqual((await service.getAlbum({ albumId: otherAlbumId })).album.tracks.map(track => track.assetId), other.assetIds)
    assert.deepEqual((await service.getAlbum({ albumId: newAlbumId })).album.tracks.map(track => track.assetId), [fourId])
  })

  run('links provider IDs from deterministic and user sources only', async service => {
    const { result, album } = await seed(service)
    await service.registerSource(musicbrainz)
    await service.registerSource(model)
    const link = await service.linkProvider({ sourceId: musicbrainz.id, kind: 'album', externalId: 'mb-release', subject: album, linkedAt: T2 })
    assert.deepEqual(link, { sourceId: musicbrainz.id, kind: 'album', externalId: 'mb-release', subject: album, evidenceClass: 'deterministic', linkedAt: T2 })
    assert.deepEqual(await service.linkProvider({ ...link, linkedAt: T3 }), link)
    assert.deepEqual(await service.resolveProviderId({ sourceId: musicbrainz.id, kind: 'album', externalId: 'mb-release' }), { subject: album })
    assert.ok((await service.getAlbum({ albumId: album.id })).album.links.some(item => item.externalId === 'mb-release'))
    const asset = { kind: 'asset', id: result.assetIds[0] }
    await assert.rejects(service.linkProvider({ sourceId: model.id, kind: 'track', externalId: 'guess', subject: asset, linkedAt: T2 }), /^Error: model-cannot-link:/)
    await assert.rejects(service.linkProvider({ sourceId: musicbrainz.id, kind: 'album', externalId: 'mb-release', subject: { kind: 'album', id: 'album-none' }, linkedAt: T2 }), /^Error: unknown-subject:/)
    await assert.rejects(service.linkProvider({ sourceId: musicbrainz.id, kind: 'track', externalId: 'mb-recording', subject: album, linkedAt: T2 }), /^Error: invalid-request:/)
    await assert.rejects(service.ingestScan(scan([file('five', 'guess-album', 1)], { providerSourceId: model.id })), /^Error: model-cannot-link:/)
  })

  run('records observations with propagated licence and evidence class', async service => {
    const { album } = await seed(service)
    for (const source of [model, musicbrainz, mbTags]) await service.registerSource(source)
    const title = await service.recordObservation({ sourceId: musicbrainz.id, subject: album, field: 'title', value: 'Blue', observedAt: T1 })
    assert.deepEqual(title, { id: title.id, sourceId: musicbrainz.id, subject: album, field: 'title', value: 'Blue', observedAt: T1, evidenceClass: 'deterministic', licence: 'CC0-1.0' })
    assert.deepEqual(await service.recordObservation({ sourceId: musicbrainz.id, subject: album, field: 'title', value: 'Blue', observedAt: T1 }), title)
    const genres = await service.recordObservation({ sourceId: mbTags.id, subject: album, field: 'genres', value: ['folk'], observedAt: T1 })
    const embedding = await service.recordObservation({ sourceId: model.id, subject: album, field: 'embedding', value: [1, 0], observedAt: T1 })
    assert.equal(embedding.licence, 'CC-BY-4.0')
    const derived = await service.recordObservation({ sourceId: model.id, subject: album, field: 'trait.mood', value: ESTIMATED_ENERGY, observedAt: T2, derivedFrom: [genres.id, embedding.id] })
    assert.equal(derived.licence, 'CC-BY-NC-SA-3.0')
    assert.deepEqual(derived.derivedFrom, [genres.id, embedding.id])
    const laundered = await service.recordObservation({ sourceId: folder.id, subject: album, field: 'title', value: 'Guess', observedAt: T2, derivedFrom: [embedding.id] })
    assert.equal(laundered.evidenceClass, 'model')
    assert.equal(laundered.licence, 'CC-BY-4.0')
    const { fields } = (await service.getAlbum({ albumId: album.id })).album
    assert.deepEqual(fields.title, { value: 'Blue', evidenceClass: 'deterministic', sourceId: musicbrainz.id, licence: 'CC0-1.0', observedAt: T1 })
    assert.equal(fields['trait.mood'], undefined)
    await assert.rejects(service.recordObservation({ sourceId: 'nobody', subject: album, field: 'title', value: 'x', observedAt: T1 }), /^Error: unknown-source:/)
    await assert.rejects(service.recordObservation({ sourceId: model.id, subject: { kind: 'album', id: 'album-none' }, field: 'title', value: 'x', observedAt: T1 }), /^Error: unknown-subject:/)
    await assert.rejects(service.recordObservation({ sourceId: model.id, subject: album, field: 'title', value: 'x', observedAt: T1, derivedFrom: ['observation-none'] }), /^Error: unknown-observation:/)
    await assert.rejects(service.recordObservation({ sourceId: model.id, subject: album, field: 'trait.energy', value: OUT_OF_RANGE, observedAt: T1 }), /^Error: invalid-request:/)
    await assert.rejects(service.recordObservation({ sourceId: model.id, subject: album, field: 'trait.tempo', value: ENERGY, observedAt: T1 }), /^Error: invalid-request:/)
  })

  run('marks traits as hand-set or estimated, and hand-set always wins', async service => {
    const { result, album } = await seed(service)
    await service.registerSource(model)
    const traits = async () => (await service.getAlbum({ albumId: album.id })).album.traits
    await service.recordObservation({ sourceId: model.id, subject: album, field: 'trait.energy', value: ESTIMATED_ENERGY, observedAt: T1 })
    await service.recordObservation({ sourceId: model.id, subject: album, field: 'trait.vocal', value: ESTIMATED_ENERGY, observedAt: T1 })
    assert.deepEqual(await traits(), {
      energy: { value: ESTIMATED_ENERGY, provenance: 'estimated', sourceId: model.id, licence: 'CC-BY-4.0', observedAt: T1 },
      vocal: { value: ESTIMATED_ENERGY, provenance: 'estimated', sourceId: model.id, licence: 'CC-BY-4.0', observedAt: T1 },
    })
    const decision = await service.recordUserDecision({ kind: 'trait', subject: album, trait: 'energy', value: ENERGY, decidedAt: T2 })
    assert.deepEqual(decision, { id: decision.id, sourceId: USER_SOURCE_ID, kind: 'trait', subject: album, trait: 'energy', value: ENERGY, decidedAt: T2 })
    await service.recordObservation({ sourceId: model.id, subject: album, field: 'trait.energy', value: NEWER_ESTIMATE, observedAt: T4 })
    assert.deepEqual((await traits()).energy, { value: ENERGY, provenance: 'hand-set', sourceId: USER_SOURCE_ID, licence: 'user', observedAt: T2 })
    assert.equal((await traits()).vocal.provenance, 'estimated')
    // Replaying an older decision, as a repeated migration does, changes nothing.
    assert.deepEqual(await service.recordUserDecision({ kind: 'trait', subject: album, trait: 'energy', value: ESTIMATED_ENERGY, decidedAt: T1 }), decision)
    assert.equal((await traits()).energy.value, ENERGY)
    // Clearing the hand-set value shows the newest estimate again.
    await service.recordUserDecision({ kind: 'trait', subject: album, trait: 'energy', decidedAt: T3 })
    assert.deepEqual((await traits()).energy, { value: NEWER_ESTIMATE, provenance: 'estimated', sourceId: model.id, licence: 'CC-BY-4.0', observedAt: T4 })
    const asset = { kind: 'asset', id: result.assetIds[0] }
    await service.recordUserDecision({ kind: 'favorite', subject: asset, value: true, decidedAt: T1 })
    assert.equal((await service.getAsset({ assetId: asset.id })).asset.favorite, true)
    assert.equal((await service.getAlbum({ albumId: album.id })).album.favorite, false)
    await assert.rejects(service.recordUserDecision({ kind: 'trait', subject: album, trait: 'energy', value: OUT_OF_RANGE, decidedAt: T4 }), /^Error: invalid-request:/)
    await assert.rejects(service.recordUserDecision({ kind: 'favorite', subject: { kind: 'album', id: 'album-none' }, value: true, decidedAt: T4 }), /^Error: unknown-subject:/)
  })

  run('refuses analysis for assets of a source that forbids it', async service => {
    await service.registerSource({ ...folder, policy: { ...policy, analysisAllowed: false } })
    await service.registerSource(navidrome)
    const { assetIds } = await service.ingestScan(scan([file('one', 'nd-album', 1)]))
    assert.equal((await service.getAsset({ assetId: assetIds[0] })).asset.analysisAllowed, false)
    await service.registerSource(folder)
    assert.equal((await service.getAsset({ assetId: assetIds[0] })).asset.analysisAllowed, true)
  })

  // The ledger, the projections and undo (plan phase A1b).
  const tagged = (name, albumId, track, tags, trackId) => ({ ...file(name, albumId, track, trackId), tags })
  const blue = { album: 'Kind of Blue', albumArtist: 'Miles Davis', artist: 'Miles Davis', year: YEAR, genre: 'Jazz' }
  const aguas = { album: 'Águas de Março', artist: 'Elis Regina' }
  // Two albums with tags: three tracks by Miles Davis and one by Elis Regina.
  const library = async service => {
    await service.registerSource(folder)
    await service.registerSource(navidrome)
    const result = await service.ingestScan(scan([
      tagged('so-what', 'nd-blue', 1, { ...blue, title: 'So What' }), tagged('green', 'nd-blue', 2, { ...blue, title: 'Blue in Green' }),
      tagged('all-blues', 'nd-blue', 3, { ...blue, title: 'All Blues' }), tagged('aguas', 'nd-aguas', 1, { ...aguas, title: 'Águas de Março' }),
    ]))
    const [blueId, aguasId] = result.albumIds
    return { result, blueId, aguasId, blueAlbum: { kind: 'album', id: blueId }, aguasAlbum: { kind: 'album', id: aguasId }, assetIds: result.assetIds }
  }
  const user = { kind: 'user' }
  const route = { kind: 'route', id: 'route-tags' }
  const setTitle = (subject, value) => ({ kind: 'set-field', subject, field: 'title', value })
  const commit = (service, id, operations, extra = {}) => service.commitChangeSet({ id, author: user, operations, committedAt: T2, ...extra })
  const applied = async (service, id, operations, extra) => {
    const result = await commit(service, id, operations, extra)
    assert.equal(result.status, 'applied', JSON.stringify(result))
    return result
  }
  const titleOf = async (service, albumId) => (await service.getCatalogAlbum({ albumId })).album.title
  const stateOf = async (service, id) => (await service.getChangeSet({ id })).changeSet.state
  const consistent = async service => assert.deepEqual((await service.verifyProjections()).differing, [])

  run('a provider re-ID is projected: the new ID comes first and the album version moves', async service => {
    const { blueId } = await library(service)
    const before = (await service.getCatalogAlbum({ albumId: blueId })).album
    await service.ingestScan(scan([
      tagged('so-what', 'nd-blue-2', 1, { ...blue, title: 'So What' }, 'nd-so-what-2'), tagged('green', 'nd-blue-2', 2, { ...blue, title: 'Blue in Green' }),
      tagged('all-blues', 'nd-blue-2', 3, { ...blue, title: 'All Blues' }), tagged('aguas', 'nd-aguas', 1, { ...aguas, title: 'Águas de Março' }),
    ], { observedAt: T2 }))
    const { album } = await service.getCatalogAlbum({ albumId: blueId })
    assert.deepEqual(album.links.map(link => link.externalId), ['nd-blue-2', 'nd-blue'])
    assert.deepEqual(album.tracks[0].links.map(link => link.externalId), [`${before.tracks[0].links[0].externalId}-2`])
    const { asset } = await service.getAsset({ assetId: album.tracks[0].assetId })
    assert.ok(asset.links.some(link => link.externalId === before.tracks[0].links[0].externalId))
    assert.ok(album.version > before.version)
    await consistent(service)
  })

  run('a numbering repair survives a rescan and Undo reveals the latest tags', async service => {
    const { result, albumId } = await seed(service)
    const [assetId] = result.assetIds
    const correctedTrack = 4
    const position = async () => {
      const { album } = await service.getCatalogAlbum({ albumId })
      const { disc, track } = album.tracks.find(item => item.assetId === assetId)
      return [disc, track]
    }
    await applied(service, 'repair-numbering', [{ kind: 'move-track', assetId, albumId, disc: 2, track: correctedTrack }])
    assert.deepEqual(await position(), [2, correctedTrack])
    await service.ingestScan(scan([file('one', 'nd-album', 2), file('two', 'nd-album', 1)], { observedAt: T3 }))
    assert.deepEqual(await position(), [2, correctedTrack])
    assert.equal((await service.undoChangeSet({ id: 'repair-numbering', undoneAt: T4 })).status, 'undone')
    assert.deepEqual(await position(), [undefined, 2])
    await consistent(service)
  })

  run('the artist album page matches search credits and counts an album only once', async service => {
    await service.registerSource(folder)
    await service.registerSource(navidrome)
    const guest = 'Vemrul Quenavosk', host = 'Grelvok Ulnespri'
    const tracks = [
      tagged('one', 'nd-morvask', 1, { album: 'Morvask', albumArtist: host, artist: guest }),
      tagged('two', 'nd-morvask', 2, { album: 'Morvask', albumArtist: host, artist: guest }),
      tagged('three', 'nd-ulvresh', 1, { album: 'Ulvresh', albumArtist: host, artist: guest }),
      tagged('four', 'nd-pavrel', 1, { album: 'Pavrel', albumArtist: host }),
    ]
    const { albumIds: [first, second] } = await service.ingestScan(scan(tracks))
    const { artists } = await service.searchCatalog({ query: guest, kinds: ['artist'] })
    assert.deepEqual(artists, [{ name: guest, albumCount: 2 }])
    for (const [offset, id] of [first, second].entries()) {
      const page = await service.listCatalogAlbums({ artist: artists[0].name, limit: 1, offset })
      assert.equal(page.total, artists[0].albumCount)
      assert.deepEqual(page.albums.map(album => album.id), [id])
    }
  })

  run('projects albums and tracks, and finds them by word, case and accent', async service => {
    const { blueId, aguasId, assetIds } = await library(service)
    const page = await service.listCatalogAlbums({})
    assert.deepEqual(page.albums.map(album => [album.id, album.title, album.artist, album.year, album.trackCount]), [
      [aguasId, 'Águas de Março', 'Elis Regina', undefined, 1], [blueId, 'Kind of Blue', 'Miles Davis', YEAR, 3],
    ])
    assert.equal(page.total, 2)
    assert.ok(page.version > 0)
    assert.deepEqual((await service.listCatalogAlbums({ sort: 'added' })).albums.map(album => album.id), [blueId, aguasId])
    assert.deepEqual((await service.listCatalogAlbums({ sort: 'title', offset: 1 })).albums.map(album => album.id), [blueId])
    const { album } = await service.getCatalogAlbum({ albumId: blueId })
    assert.deepEqual(album.tracks.map(track => [track.assetId, track.position, track.title, track.artist, track.availability]), [
      [assetIds[0], 0, 'So What', 'Miles Davis', 'available'], [assetIds[1], 1, 'Blue in Green', 'Miles Davis', 'available'], [assetIds[2], 2, 'All Blues', 'Miles Davis', 'available'],
    ])
    assert.deepEqual(album.locks, [])
    assert.equal((await service.getCatalogAlbum({ albumId: 'album-none' })).album, undefined)
    const found = await service.searchCatalog({ query: 'BLU' })
    assert.deepEqual(found.albums.map(item => item.id), [blueId])
    assert.deepEqual(found.tracks.map(track => track.title), ['All Blues', 'Blue in Green'])
    assert.deepEqual(found.artists, [])
    assert.deepEqual((await service.searchCatalog({ query: 'aguas marco' })).albums.map(item => item.id), [aguasId])
    assert.deepEqual((await service.searchCatalog({ query: 'dav mil', kinds: ['artist'] })), { albums: [], artists: [{ name: 'Miles Davis', albumCount: 1 }], tracks: [], version: page.version })
    assert.deepEqual((await service.searchCatalog({ query: 'miles what' })).tracks.map(track => track.title), ['So What'])
    assert.deepEqual((await service.searchCatalog({ query: ' -- ' })).albums, [])
    assert.deepEqual((await service.searchCatalog({ query: 'blue', limit: 1 })).tracks.map(track => track.title), ['All Blues'])
    // A page further on, for a search that loads more.
    assert.deepEqual((await service.searchCatalog({ query: 'blue', limit: 1, offset: 1 })).tracks.map(track => track.title), ['Blue in Green'])
    assert.deepEqual((await service.searchCatalog({ query: 'blue', kinds: ['album'], offset: 1 })).albums, [])
    await assert.rejects(service.searchCatalog({ query: 'blue', offset: -1 }), /^Error: invalid-request:/)
    // What the window builds covers and streams from: the provider's own IDs, and when the album was added.
    assert.deepEqual(page.albums.map(item => [item.links, item.addedAt, item.genre]), [[[{ sourceId: navidrome.id, externalId: 'nd-aguas' }], T1, undefined], [[{ sourceId: navidrome.id, externalId: 'nd-blue' }], T1, 'Jazz']])
    assert.deepEqual(album.tracks.map(track => track.links), ['so-what', 'green', 'all-blues'].map(name => [{ sourceId: navidrome.id, externalId: `nd-${name}` }]))
    await assert.rejects(service.searchCatalog({ query: 'blue', kinds: ['genre'] }), /^Error: invalid-request:/)
    // A re-scan that says nothing new changes no projection and no version.
    await service.ingestScan(scan([
      tagged('so-what', 'nd-blue', 1, { ...blue, title: 'So What' }), tagged('green', 'nd-blue', 2, { ...blue, title: 'Blue in Green' }),
      tagged('all-blues', 'nd-blue', 3, { ...blue, title: 'All Blues' }), tagged('aguas', 'nd-aguas', 1, { ...aguas, title: 'Águas de Março' }),
    ], { observedAt: T2 }))
    assert.deepEqual(await service.listCatalogAlbums({}), page)
    await consistent(service)
  })

  run('commits a change set atomically and projects it in the same call', async service => {
    const { blueId, blueAlbum, aguasAlbum } = await library(service)
    const before = (await service.listCatalogAlbums({})).version
    const result = await applied(service, 'change-1', [setTitle(blueAlbum, 'Kind Of Blue (Mono)'), { kind: 'set-field', subject: aguasAlbum, field: 'year', value: YEAR }], { summary: 'Fix two albums' })
    assert.deepEqual(result.changeSet, {
      id: 'change-1', author: user, state: 'applied', committedAt: T2, version: result.version, summary: 'Fix two albums', dependsOn: [], dependents: [], undos: [],
      operations: [{ operation: setTitle(blueAlbum, 'Kind Of Blue (Mono)'), state: 'applied', before: 'Kind of Blue' }, { operation: { kind: 'set-field', subject: aguasAlbum, field: 'year', value: YEAR }, state: 'applied' }],
      evidence: [{ evidenceClass: 'user', supports: true, sourceId: USER_SOURCE_ID }], verdict: { approvable: true, basis: 'user' },
    })
    assert.equal(result.version, before + 1)
    assert.equal(result.replayed, false)
    const { album } = await service.getCatalogAlbum({ albumId: blueId })
    assert.equal(album.title, 'Kind Of Blue (Mono)')
    assert.equal(album.version, result.version)
    assert.deepEqual((await service.getAlbum({ albumId: blueId })).album.fields.title, { value: 'Kind Of Blue (Mono)', evidenceClass: 'user', sourceId: USER_SOURCE_ID, licence: 'user', observedAt: T2, changeSetId: 'change-1' })
    assert.deepEqual((await service.searchCatalog({ query: 'mono', kinds: ['album'] })).albums.map(item => item.id), [blueId])
    assert.deepEqual(await service.getChangeSet({ id: 'change-1' }), { changeSet: result.changeSet })
    assert.deepEqual(await service.getChangeSet({ id: 'change-none' }), {})
    // One bad operation and nothing of the change set is applied or recorded.
    await assert.rejects(commit(service, 'change-2', [setTitle(aguasAlbum, 'Half done'), setTitle({ kind: 'album', id: 'album-none' }, 'x')]), /^Error: unknown-subject:/)
    assert.equal(await titleOf(service, aguasAlbum.id), 'Águas de Março')
    assert.equal((await service.listChangeSets({})).total, 1)
    assert.equal((await service.listCatalogAlbums({})).version, result.version)
    await assert.rejects(commit(service, 'change-3', []), /^Error: invalid-request:/)
    await assert.rejects(commit(service, '/not/an/id', [setTitle(aguasAlbum, 'x')]), /^Error: invalid-request:/)
    await assert.rejects(commit(service, 'change-4', [{ kind: 'rename-everything' }]), /^Error: invalid-request:/)
    await consistent(service)
  })

  run('approves automated changes on deterministic evidence only', async service => {
    const { blueAlbum, blueId } = await library(service)
    for (const source of [model, musicbrainz]) await service.registerSource(source)
    const guess = await service.recordObservation({ sourceId: model.id, subject: blueAlbum, field: 'year-guess', value: YEAR, observedAt: T1 })
    const release = await service.recordObservation({ sourceId: musicbrainz.id, subject: blueAlbum, field: 'release-year', value: YEAR, observedAt: T1 })
    const laundered = await service.recordObservation({ sourceId: musicbrainz.id, subject: blueAlbum, field: 'derived-year', value: YEAR, observedAt: T1, derivedFrom: [guess.id] })
    const { version } = await service.listCatalogAlbums({})
    const propose = (id, evidence, author = route) => commit(service, id, [setTitle(blueAlbum, 'Kind of Blue (Legacy Edition)')], { author, evidence, baseVersion: version })
    assert.deepEqual(await propose('auto-1', []), { status: 'rejected', reason: 'not-approvable', version, verdict: { approvable: false, reason: 'no-evidence' } })
    assert.deepEqual((await propose('auto-1', [{ supports: true, observationId: guess.id }, { supports: true, sourceId: model.id }])).verdict, { approvable: false, reason: 'model-only' })
    // A deterministic source that only passes on a model's guess is model evidence.
    assert.deepEqual((await propose('auto-1', [{ supports: true, observationId: laundered.id }])).verdict, { approvable: false, reason: 'model-only' })
    assert.deepEqual((await propose('auto-1', [{ supports: true, observationId: release.id }, { supports: false, sourceId: folder.id }])).verdict, { approvable: false, reason: 'contradicted' })
    assert.equal(await titleOf(service, blueId), 'Kind of Blue')
    assert.equal((await service.listChangeSets({})).total, 0)
    // An author cannot claim a class: user evidence comes from a user author only.
    await assert.rejects(propose('auto-1', [{ supports: true, sourceId: USER_SOURCE_ID }]), /^Error: invalid-request:/)
    await assert.rejects(propose('auto-1', [{ supports: true, sourceId: 'nobody' }]), /^Error: unknown-source:/)
    await assert.rejects(propose('auto-1', [{ supports: true, observationId: 'observation-none' }]), /^Error: unknown-observation:/)
    await assert.rejects(commit(service, 'auto-1', [setTitle(blueAlbum, 'x')], { author: route, evidence: [{ supports: true, observationId: release.id }] }), /^Error: invalid-request:/)
    await assert.rejects(commit(service, 'auto-1', [{ kind: 'set-field', subject: blueAlbum, field: 'trait.energy', value: ENERGY }], { author: route, baseVersion: version, evidence: [{ supports: true, observationId: release.id }] }), /^Error: invalid-request:/)
    const result = await propose('auto-1', [{ supports: true, observationId: release.id }, { supports: false, observationId: guess.id }])
    assert.equal(result.status, 'applied')
    assert.deepEqual(result.changeSet.verdict, { approvable: true, basis: 'deterministic' })
    assert.deepEqual(result.changeSet.evidence, [
      { evidenceClass: 'deterministic', supports: true, sourceId: musicbrainz.id, observationId: release.id }, { evidenceClass: 'model', supports: false, sourceId: model.id, observationId: guess.id },
    ])
    assert.deepEqual((await service.getAlbum({ albumId: blueId })).album.fields.title, { value: 'Kind of Blue (Legacy Edition)', evidenceClass: 'deterministic', sourceId: musicbrainz.id, licence: 'CC0-1.0', observedAt: T2, changeSetId: 'auto-1' })
    // The user approving what a model suggested is a user change.
    assert.deepEqual((await applied(service, 'user-1', [setTitle(blueAlbum, 'KoB')], { evidence: [{ supports: true, observationId: guess.id }] })).changeSet.verdict, { approvable: true, basis: 'user' })
  })

  run('merges, splits, moves and relinks, and undoes each', async service => {
    const { blueId, aguasId, assetIds } = await library(service)
    const [soWhat, green, allBlues, aguasTrack] = assetIds
    const tracksOf = async albumId => (await service.getAlbum({ albumId })).album.tracks.map(track => track.assetId)
    const rescan = () => service.ingestScan(scan([file('so-what', 'nd-blue', 1), file('green', 'nd-blue', 2), file('all-blues', 'nd-blue', 3), file('aguas', 'nd-aguas', 1)], { observedAt: T3 }))
    await applied(service, 'merge-1', [{ kind: 'merge-albums', into: blueId, from: [aguasId] }])
    assert.deepEqual((await tracksOf(blueId)).sort(), [...assetIds].sort())
    assert.deepEqual(await service.resolveProviderId({ sourceId: navidrome.id, kind: 'album', externalId: 'nd-aguas' }), { subject: { kind: 'album', id: blueId } })
    assert.equal((await service.listAlbums({})).total, 1)
    assert.equal((await service.listCatalogAlbums({})).total, 1)
    assert.equal((await service.getCatalogAlbum({ albumId: blueId })).album.trackCount, assetIds.length)
    assert.deepEqual((await service.getAlbum({ albumId: aguasId })).album.tracks, [])
    // The scanner still files the track under its own album, and no longer disagrees.
    assert.deepEqual((await rescan()).conflicts, [])
    assert.deepEqual(await service.undoChangeSet({ id: 'merge-1', undoneAt: T4 }).then(result => [result.status, result.changeSets.map(item => item.state)]), ['undone', ['undone']])
    assert.deepEqual(await tracksOf(aguasId), [aguasTrack])
    assert.deepEqual(await service.resolveProviderId({ sourceId: navidrome.id, kind: 'album', externalId: 'nd-aguas' }), { subject: { kind: 'album', id: aguasId } })
    assert.equal((await service.listCatalogAlbums({})).total, 2)

    const split = await applied(service, 'split-1', [{ kind: 'split-album', albumId: blueId, assetIds: [allBlues] }])
    const { createdAlbumId } = split.changeSet.operations[0]
    assert.match(createdAlbumId, ID_PATTERN)
    assert.deepEqual(await tracksOf(blueId), [soWhat, green])
    assert.deepEqual(await tracksOf(createdAlbumId), [allBlues])
    assert.equal((await service.listCatalogAlbums({})).total, 3)
    await assert.rejects(commit(service, 'split-2', [{ kind: 'split-album', albumId: blueId, assetIds: [soWhat, green] }]), /^Error: invalid-request:/)
    await assert.rejects(commit(service, 'split-2', [{ kind: 'split-album', albumId: blueId, assetIds: [aguasTrack] }]), /^Error: invalid-request:/)
    await applied(service, 'move-1', [{ kind: 'move-track', assetId: green, albumId: createdAlbumId, track: 1 }])
    assert.deepEqual(await tracksOf(createdAlbumId), [green, allBlues])
    assert.equal((await service.getAsset({ assetId: green })).asset.albumId, createdAlbumId)
    await applied(service, 'relink-1', [{ kind: 'relink-provider', sourceId: navidrome.id, linkKind: 'album', externalId: 'nd-split', subject: { kind: 'album', id: createdAlbumId } }])
    assert.deepEqual(await service.resolveProviderId({ sourceId: navidrome.id, kind: 'album', externalId: 'nd-split' }), { subject: { kind: 'album', id: createdAlbumId } })
    await service.registerSource(model)
    await assert.rejects(commit(service, 'relink-2', [{ kind: 'relink-provider', sourceId: model.id, linkKind: 'album', externalId: 'guess', subject: { kind: 'album', id: blueId } }]), /^Error: model-cannot-link:/)
    await assert.rejects(commit(service, 'relink-2', [{ kind: 'relink-provider', sourceId: navidrome.id, linkKind: 'track', externalId: 'x', subject: { kind: 'album', id: blueId } }]), /^Error: invalid-request:/)
    // The move and the relink build on the album the split made, so they go with it.
    assert.deepEqual((await service.getChangeSet({ id: 'split-1' })).changeSet.dependents, ['move-1', 'relink-1'])
    const undone = await service.undoChangeSet({ id: 'split-1', cascade: true, undoneAt: T4 })
    assert.deepEqual(undone.changeSets.map(item => [item.id, item.state]), [['split-1', 'undone'], ['relink-1', 'undone'], ['move-1', 'undone']])
    assert.deepEqual(await tracksOf(blueId), [soWhat, green, allBlues])
    assert.deepEqual(await service.resolveProviderId({ sourceId: navidrome.id, kind: 'album', externalId: 'nd-split' }), {})
    assert.equal((await service.listCatalogAlbums({})).total, 2)
    await consistent(service)
  })

  run('undo respects dependencies, and is recorded', async service => {
    const { blueId, blueAlbum, aguasAlbum, assetIds } = await library(service)
    const split = await applied(service, 'split-1', [{ kind: 'split-album', albumId: blueId, assetIds: [assetIds[2]] }])
    const created = { kind: 'album', id: split.changeSet.operations[0].createdAlbumId }
    await applied(service, 'title-1', [setTitle(created, 'All Blues (Single)')], { committedAt: T3 })
    await applied(service, 'note-1', [{ kind: 'set-field', subject: aguasAlbum, field: 'note', value: 'after the split' }], { dependsOn: ['split-1'], committedAt: T3 })
    const version = (await service.listCatalogAlbums({})).version
    assert.deepEqual(await service.undoChangeSet({ id: 'split-1', undoneAt: T4 }), { status: 'blocked', reason: 'has-dependents', blockedBy: ['title-1', 'note-1'], version })
    assert.equal(await stateOf(service, 'split-1'), 'applied')
    assert.equal((await service.getAlbum({ albumId: blueId })).album.tracks.length, 2)
    const undone = await service.undoChangeSet({ id: 'split-1', cascade: true, undoneAt: T4 })
    assert.deepEqual(undone.changeSets.map(item => [item.id, item.state, item.undos]), [
      ['split-1', 'undone', [{ operations: [0], author: user, undoneAt: T4 }]],
      ['note-1', 'undone', [{ operations: [0], author: user, undoneAt: T4, causedBy: 'split-1' }]],
      ['title-1', 'undone', [{ operations: [0], author: user, undoneAt: T4, causedBy: 'split-1' }]],
    ])
    assert.equal((await service.getAlbum({ albumId: blueId })).album.tracks.length, assetIds.length - 1)
    assert.equal((await service.getAlbum({ albumId: aguasAlbum.id })).album.fields.note, undefined)
    // Undoing again changes nothing and records nothing.
    const again = await service.undoChangeSet({ id: 'split-1', cascade: true, undoneAt: T4 })
    assert.deepEqual(again.changeSets.map(item => item.undos.length), [1])
    assert.equal(again.version, undone.version)
    assert.deepEqual((await service.listChangeSets({})).changeSets.map(item => item.id), ['note-1', 'title-1', 'split-1'])
    assert.deepEqual((await service.listChangeSets({ offset: 1, limit: 1 })).changeSets.map(item => item.id), ['title-1'])
    await assert.rejects(service.undoChangeSet({ id: 'change-none', undoneAt: T4 }), /^Error: unknown-change-set:/)
    await assert.rejects(commit(service, 'note-2', [setTitle(blueAlbum, 'x')], { dependsOn: ['change-none'] }), /^Error: unknown-change-set:/)
    assert.deepEqual(await commit(service, 'note-2', [setTitle(blueAlbum, 'x')], { dependsOn: ['split-1'] }), { status: 'rejected', reason: 'dependency-not-applied', dependsOn: ['split-1'], version: undone.version })
    await consistent(service)
  })

  run('undoes one field or one operation, and marks what was superseded', async service => {
    const { blueId, blueAlbum } = await library(service)
    await applied(service, 'title-1', [setTitle(blueAlbum, 'First'), { kind: 'set-field', subject: blueAlbum, field: 'year', value: OTHER_YEAR }])
    await applied(service, 'title-2', [setTitle(blueAlbum, 'Second')], { committedAt: T3 })
    assert.deepEqual((await service.getChangeSet({ id: 'title-1' })).changeSet.dependents, ['title-2'])
    assert.equal(await stateOf(service, 'title-1'), 'applied')
    // Only the year: the title of the same change set stays, and so does the change set.
    const year = await service.undoChangeSet({ id: 'title-1', operations: [1], undoneAt: T4 })
    assert.deepEqual(year.changeSets[0].operations.map(item => item.state), ['applied', 'undone'])
    assert.equal((await service.getCatalogAlbum({ albumId: blueId })).album.year, YEAR)
    assert.equal(await titleOf(service, blueId), 'Second')
    assert.equal(await stateOf(service, 'title-1'), 'superseded')
    assert.equal((await service.undoChangeSet({ id: 'title-1', undoneAt: T4 })).reason, 'has-dependents')
    const field = { subject: blueAlbum, field: 'title', undoneAt: T4 }
    assert.deepEqual((await service.undoField(field)).changeSets.map(item => [item.id, item.state]), [['title-2', 'undone']])
    assert.equal(await titleOf(service, blueId), 'First')
    assert.equal(await stateOf(service, 'title-1'), 'applied')
    assert.deepEqual((await service.undoField(field)).changeSets.map(item => [item.id, item.state]), [['title-1', 'undone']])
    assert.equal(await titleOf(service, blueId), 'Kind of Blue')
    assert.deepEqual(await service.undoField(field), { status: 'blocked', reason: 'nothing-to-undo', blockedBy: [], version: (await service.listCatalogAlbums({})).version })
    await consistent(service)
  })

  run('records a hand-set trait as a change set and puts the earlier value back', async service => {
    const { blueId, blueAlbum } = await library(service)
    await service.registerSource(model)
    await service.recordObservation({ sourceId: model.id, subject: blueAlbum, field: 'trait.energy', value: ESTIMATED_ENERGY, observedAt: T1 })
    const energy = async () => (await service.getCatalogAlbum({ albumId: blueId })).album.traits.energy
    const set = (id, value, committedAt) => applied(service, id, [{ kind: 'set-field', subject: blueAlbum, field: 'trait.energy', value }], { committedAt })
    await set('energy-1', ENERGY, T2)
    assert.deepEqual(await energy(), { value: ENERGY, provenance: 'hand-set', sourceId: USER_SOURCE_ID, licence: 'user', observedAt: T2 })
    await set('energy-2', NEWER_ESTIMATE, T3)
    await service.undoField({ subject: blueAlbum, field: 'trait.energy', undoneAt: T4 })
    assert.equal((await energy()).value, ENERGY)
    assert.equal((await energy()).provenance, 'hand-set')
    // A replayed migration is older than the undo, so it cannot bring the undone value back.
    await service.recordUserDecision({ kind: 'trait', subject: blueAlbum, trait: 'energy', value: NEWER_ESTIMATE, decidedAt: T3 })
    assert.equal((await energy()).value, ENERGY)
    await service.undoChangeSet({ id: 'energy-1', undoneAt: T4 })
    assert.equal((await energy()).provenance, 'estimated')
    // A value changed outside the ledger since is not overwritten by an undo.
    await set('energy-3', ENERGY, T4)
    await service.recordUserDecision({ kind: 'trait', subject: blueAlbum, trait: 'energy', value: ESTIMATED_ENERGY, decidedAt: T5 })
    const blocked = await service.undoChangeSet({ id: 'energy-3', undoneAt: T5 })
    assert.deepEqual([blocked.status, blocked.reason, blocked.blockedBy], ['blocked', 'changed-since', ['energy-3']])
    assert.equal((await energy()).value, ESTIMATED_ENERGY)
    assert.equal(await stateOf(service, 'energy-3'), 'applied')
    await assert.rejects(commit(service, 'energy-4', [{ kind: 'set-field', subject: blueAlbum, field: 'trait.energy', value: OUT_OF_RANGE }]), /^Error: invalid-request:/)
    await consistent(service)
  })

  run('a gesture continued is one change set, and its undo restores the value from before it', async service => {
    const { blueId, blueAlbum, aguasAlbum } = await library(service)
    const energy = async () => (await service.getCatalogAlbum({ albumId: blueId })).album.traits.energy?.value
    const drag = (id, value, committedAt, amends, subject = blueAlbum) => applied(service, id, [{ kind: 'set-field', subject, field: 'trait.energy', value }], { committedAt, amends })
    await drag('before', ESTIMATED_ENERGY, T1)
    await drag('drag-1', NEWER_ESTIMATE, T2)
    const second = await drag('drag-2', ENERGY, T3, 'drag-1')
    assert.deepEqual([second.changeSet.id, second.changeSet.committedAt, second.changeSet.operations[0].operation.value, second.replayed], ['drag-1', T3, ENERGY, false])
    assert.equal(await energy(), ENERGY)
    assert.deepEqual((await service.listChangeSets({})).changeSets.map(item => item.id), ['drag-1', 'before'])
    assert.deepEqual(await service.getChangeSet({ id: 'drag-2' }), {})
    // Sent again after a lost reply, it changes nothing more.
    assert.equal((await drag('drag-2', ENERGY, T3, 'drag-1')).version, second.version)
    await service.undoChangeSet({ id: 'drag-1', undoneAt: T4 })
    assert.equal(await energy(), ESTIMATED_ENERGY)
    // What cannot be continued is committed on its own: an undone change set, another album,
    // one that something was built on, and an unknown one.
    assert.equal((await drag('drag-3', ENERGY, T5, 'drag-1')).changeSet.id, 'drag-3')
    assert.equal((await drag('other-1', ENERGY, T5, 'drag-3', aguasAlbum)).changeSet.id, 'other-1')
    assert.equal((await drag('drag-4', NEWER_ESTIMATE, T5)).changeSet.id, 'drag-4')
    assert.equal((await drag('drag-5', ENERGY, T5, 'drag-3')).changeSet.id, 'drag-5')
    assert.equal((await drag('drag-6', NEWER_ESTIMATE, T5, 'change-none')).changeSet.id, 'drag-6')
    const title = await applied(service, 'title-1', [setTitle(blueAlbum, 'Kind of')], { committedAt: T5 })
    const typed = await applied(service, 'title-2', [setTitle(blueAlbum, 'Kind of Blue (Mono)')], { committedAt: T5, amends: 'title-1' })
    assert.deepEqual([typed.changeSet.id, typed.version], ['title-1', title.version + 1])
    await service.undoChangeSet({ id: 'title-1', undoneAt: T5 })
    assert.equal(await titleOf(service, blueId), 'Kind of Blue')
    await consistent(service)
  })

  run('a favourite is a change set with a receipt and an undo', async service => {
    const { blueId, blueAlbum } = await library(service)
    const favorite = async () => (await service.getCatalogAlbum({ albumId: blueId })).album.favorite
    const pick = (id, value, committedAt) => applied(service, id, [{ kind: 'set-field', subject: blueAlbum, field: 'favorite', value }], { committedAt })
    await pick('favorite-1', true, T2)
    assert.equal(await favorite(), true)
    assert.equal((await service.getAlbum({ albumId: blueId })).album.favorite, true)
    await pick('favorite-2', false, T3)
    assert.equal(await favorite(), false)
    await service.undoField({ subject: blueAlbum, field: 'favorite', undoneAt: T4 })
    assert.equal(await favorite(), true)
    await service.undoChangeSet({ id: 'favorite-1', undoneAt: T4 })
    assert.equal(await favorite(), false)
    await assert.rejects(commit(service, 'favorite-3', [{ kind: 'set-field', subject: blueAlbum, field: 'favorite', value: 'yes' }]), /^Error: invalid-request:/)
    await assert.rejects(commit(service, 'favorite-3', [{ kind: 'set-field', subject: blueAlbum, field: 'favorite', value: true }], { author: route, baseVersion: 0, evidence: [{ supports: true, sourceId: folder.id }] }), /^Error: invalid-request:/)
    await consistent(service)
  })

  run('an automated change the user undid is not applied again by its route', async service => {
    const { blueId, blueAlbum, aguasAlbum } = await library(service)
    const evidence = [{ supports: true, sourceId: folder.id }]
    const propose = async (id, author, operations) => commit(service, id, operations, { author, evidence, baseVersion: (await service.listCatalogAlbums({})).version })
    const fix = [{ kind: 'set-field', subject: blueAlbum, field: 'year', value: OTHER_YEAR }]
    assert.equal((await propose('auto-1', route, fix)).status, 'applied')
    assert.equal((await service.getCatalogAlbum({ albumId: blueId })).album.year, OTHER_YEAR)
    const undone = await service.undoChangeSet({ id: 'auto-1', undoneAt: T3 })
    assert.equal(undone.changeSets[0].state, 'suppressed')
    assert.equal((await service.getCatalogAlbum({ albumId: blueId })).album.year, YEAR)
    const { version } = undone
    assert.deepEqual(await propose('auto-2', route, fix), { status: 'rejected', reason: 'suppressed', suppressedBy: 'auto-1', version })
    assert.deepEqual(await propose('auto-2', { kind: 'job', id: 'job-7', route: route.id }, fix), { status: 'rejected', reason: 'suppressed', suppressedBy: 'auto-1', version })
    assert.equal((await service.getCatalogAlbum({ albumId: blueId })).album.year, YEAR)
    assert.equal((await service.listChangeSets({})).total, 1)
    // Another route, another value and another album are not held back.
    assert.equal((await propose('auto-3', { kind: 'route', id: 'route-other' }, fix)).status, 'applied')
    assert.equal((await propose('auto-4', route, [{ kind: 'set-field', subject: aguasAlbum, field: 'year', value: OTHER_YEAR }])).status, 'applied')
    // An automated undo, as a route withdrawing its own work, suppresses nothing.
    await service.undoChangeSet({ id: 'auto-4', author: route, undoneAt: T3 })
    assert.equal(await stateOf(service, 'auto-4'), 'undone')
    assert.equal((await propose('auto-5', route, [{ kind: 'set-field', subject: aguasAlbum, field: 'year', value: OTHER_YEAR }])).status, 'applied')
  })

  run('a field the user locked refuses automated changes', async service => {
    const { blueId, aguasId, blueAlbum } = await library(service)
    const evidence = [{ supports: true, sourceId: folder.id }]
    const propose = async (id, operations) => commit(service, id, operations, { author: route, evidence, baseVersion: (await service.listCatalogAlbums({})).version })
    await applied(service, 'lock-1', [{ kind: 'lock-field', subject: blueAlbum, field: 'title', locked: true }, { kind: 'lock-field', subject: blueAlbum, field: 'tracks', locked: true }])
    assert.deepEqual((await service.getCatalogAlbum({ albumId: blueId })).album.locks, ['title', 'tracks'])
    const refused = await propose('auto-1', [{ kind: 'set-field', subject: blueAlbum, field: 'year', value: OTHER_YEAR }, setTitle(blueAlbum, 'Renamed')])
    assert.deepEqual([refused.status, refused.reason, refused.locks], ['rejected', 'locked', [{ subject: blueAlbum, field: 'title' }]])
    assert.equal((await service.getCatalogAlbum({ albumId: blueId })).album.year, YEAR)
    assert.deepEqual((await propose('auto-1', [{ kind: 'merge-albums', into: aguasId, from: [blueId] }])).locks, [{ subject: blueAlbum, field: 'tracks' }])
    assert.equal((await service.listCatalogAlbums({})).total, 2)
    await assert.rejects(propose('auto-1', [{ kind: 'lock-field', subject: blueAlbum, field: 'title', locked: false }]), /^Error: invalid-request:/)
    // The user is not held by their own lock, and lifts it by undoing it.
    await applied(service, 'title-1', [setTitle(blueAlbum, 'Mine')], { committedAt: T3 })
    await service.undoChangeSet({ id: 'lock-1', operations: [0], undoneAt: T4 })
    assert.deepEqual((await service.getCatalogAlbum({ albumId: blueId })).album.locks, ['tracks'])
    assert.equal((await propose('auto-1', [setTitle(blueAlbum, 'Renamed')])).status, 'applied')
    assert.equal(await titleOf(service, blueId), 'Renamed')
  })

  run('a change computed against an older version is rejected or rebased, never applied blind', async service => {
    const { blueId, aguasId, blueAlbum, aguasAlbum } = await library(service)
    const evidence = [{ supports: true, sourceId: folder.id }]
    const { version: read } = await service.listCatalogAlbums({})
    // The user renames the album after the route read it.
    const edit = await applied(service, 'title-1', [setTitle(blueAlbum, 'Mine')])
    const stale = await commit(service, 'auto-1', [setTitle(blueAlbum, 'Theirs'), setTitle(aguasAlbum, 'Theirs too')], { author: route, evidence, baseVersion: read })
    assert.deepEqual(stale, { status: 'rejected', reason: 'stale', subjects: [blueAlbum], version: edit.version })
    assert.equal(await titleOf(service, blueId), 'Mine')
    assert.equal(await titleOf(service, aguasId), 'Águas de Março')
    assert.equal((await service.listChangeSets({})).total, 1)
    // The other album did not change since, so the same old version is good for it.
    const rebased = await commit(service, 'auto-2', [setTitle(aguasAlbum, 'Aguas')], { author: route, evidence, baseVersion: read })
    assert.deepEqual([rebased.status, rebased.rebased, rebased.version], ['applied', true, edit.version + 1])
    assert.equal(await titleOf(service, aguasId), 'Aguas')
    const current = await commit(service, 'auto-3', [setTitle(blueAlbum, 'Theirs')], { author: route, evidence, baseVersion: rebased.version })
    assert.deepEqual([current.status, current.rebased], ['applied', false])
    // A scan that moves an album on makes a patch computed before it stale as well.
    await service.ingestScan(scan([tagged('aguas', 'nd-aguas', 1, { ...aguas, title: 'Águas (Remaster)' })], { complete: false, observedAt: T3 }))
    assert.equal((await commit(service, 'auto-4', [setTitle(aguasAlbum, 'x')], { author: route, evidence, baseVersion: current.version })).reason, 'stale')
    assert.equal((await commit(service, 'user-1', [setTitle(aguasAlbum, 'x')], { baseVersion: current.version })).reason, 'stale')
    await assert.rejects(commit(service, 'auto-5', [setTitle(aguasAlbum, 'x')], { author: route, evidence, baseVersion: Number.MAX_SAFE_INTEGER }), /^Error: invalid-request:/)
  })

  run('a commit retried after a lost acknowledgement applies nothing twice', async service => {
    const { blueId, blueAlbum, assetIds } = await library(service)
    const operations = [{ kind: 'split-album', albumId: blueId, assetIds: [assetIds[2]] }, setTitle(blueAlbum, 'Kind of Blue (Part 1)')]
    const first = await applied(service, 'change-1', operations)
    const before = await service.listCatalogAlbums({})
    const retry = await commit(service, 'change-1', operations, { committedAt: T3 })
    assert.deepEqual(retry, { ...first, replayed: true })
    assert.deepEqual(await service.listCatalogAlbums({}), before)
    assert.equal(before.total, 3)
    assert.equal((await service.listChangeSets({})).total, 1)
    await assert.rejects(commit(service, 'change-1', [setTitle(blueAlbum, 'Something else')]), /^Error: change-set-conflict:/)
    // The same holds for an undo, and for a commit retried after its change set was undone.
    const undone = await service.undoChangeSet({ id: 'change-1', undoneAt: T4 })
    assert.deepEqual(await service.undoChangeSet({ id: 'change-1', undoneAt: T5 }), undone)
    const late = await commit(service, 'change-1', operations, { committedAt: T5 })
    assert.deepEqual([late.status, late.replayed, late.changeSet.state], ['applied', true, 'undone'])
    assert.equal(await titleOf(service, blueId), 'Kind of Blue')
    assert.equal((await service.listCatalogAlbums({})).total, 2)
  })

  run('after a restart the ledger and the projections are what they were, and equal a full rebuild', async (service, restart) => {
    const { blueId, aguasId, blueAlbum, aguasAlbum, assetIds } = await library(service)
    await applied(service, 'title-1', [setTitle(blueAlbum, 'Kind of Blue (Mono)')])
    await applied(service, 'split-1', [{ kind: 'split-album', albumId: blueId, assetIds: [assetIds[2]] }], { committedAt: T3 })
    await applied(service, 'merge-1', [{ kind: 'merge-albums', into: blueId, from: [aguasId] }], { committedAt: T3 })
    await applied(service, 'energy-1', [{ kind: 'set-field', subject: blueAlbum, field: 'trait.energy', value: ENERGY }, { kind: 'lock-field', subject: aguasAlbum, field: 'title', locked: true }], { committedAt: T3 })
    await commit(service, 'auto-1', [{ kind: 'set-field', subject: blueAlbum, field: 'year', value: OTHER_YEAR }], { author: route, evidence: [{ supports: true, sourceId: folder.id }], baseVersion: (await service.listCatalogAlbums({})).version })
    await service.undoChangeSet({ id: 'auto-1', undoneAt: T4 })
    await service.undoChangeSet({ id: 'merge-1', undoneAt: T4 })
    const snapshot = async from => ({
      albums: await from.listCatalogAlbums({}), blue: await from.getCatalogAlbum({ albumId: blueId }), search: await from.searchCatalog({ query: 'blue' }),
      artists: await from.searchCatalog({ query: 'elis', kinds: ['artist'] }), ledger: await from.listChangeSets({}), spine: await from.getAlbum({ albumId: blueId }),
    })
    const before = await snapshot(service)
    assert.equal(before.albums.total, 3)
    assert.deepEqual(before.ledger.changeSets.map(item => [item.id, item.state]), [['auto-1', 'suppressed'], ['energy-1', 'applied'], ['merge-1', 'undone'], ['split-1', 'applied'], ['title-1', 'applied']])
    const reopened = await restart()
    assert.deepEqual(await snapshot(reopened), before)
    assert.deepEqual(await reopened.verifyProjections(), { consistent: true, albums: 3, differing: [] })
    const report = await reopened.rebuildProjections()
    assert.deepEqual([report.albums, report.tracks, report.version], [3, assetIds.length, before.albums.version])
    assert.deepEqual(await snapshot(reopened), before)
    // What was true before the restart still binds after it.
    const { version } = before.albums
    assert.equal((await reopened.commitChangeSet({ id: 'auto-2', author: route, operations: [{ kind: 'set-field', subject: blueAlbum, field: 'year', value: OTHER_YEAR }], evidence: [{ supports: true, sourceId: folder.id }], baseVersion: version, committedAt: T5 })).reason, 'suppressed')
    assert.equal((await reopened.commitChangeSet({ id: 'title-1', author: user, operations: [setTitle(blueAlbum, 'Kind of Blue (Mono)')], committedAt: T5 })).replayed, true)
    assert.equal((await reopened.undoChangeSet({ id: 'split-1', undoneAt: T5 })).status, 'undone')
    assert.equal((await reopened.listCatalogAlbums({})).total, 2)
    assert.equal((await reopened.verifyProjections()).consistent, true)
  })
}

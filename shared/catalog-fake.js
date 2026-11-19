// In-memory CatalogService. The reference behaviour for the shared contract suite
// (catalog-contract-suite.js) until the SQLite service exists, and the backend of
// the virtual provider UI. Types: catalog-fake.d.ts.
import { MAX_PLAYBACK_LINKS } from './catalog-bridge.js'
import {
  APPROVING_CLASSES, CONSENT_KEYS, TRAIT_FIELD_PREFIX, TRAIT_NAMES, USER_SOURCE, USER_SOURCE_ID, catalogError, isCatalogId,
  isTraitValue, propagateEvidenceClass, propagateLicence, sourceConsentState, traitOfField, validateSource,
} from './catalog-rules.js'
import { createLedger, trackNumbering } from './catalog-ledger.js'
import {
  CATALOG_SORTS, MAX_REPORTED_DIFFERENCES, MAX_TAG_LENGTH, albumDetail, albumSummary, compareAlbums, compareArtists, compareTracks, isScanTags, matchesTerms,
  normalSearch, projectAlbum, searchRows, tagObservations,
} from './catalog-projection.js'

export const DEFAULT_ALBUM_PAGE = 50
export const MAX_ALBUM_PAGE = 500
const SUBJECT_KINDS = ['album', 'asset']
const LINK_KINDS = ['album', 'track']
const CONSENT_VALUES = ['granted', 'denied']
const FIRST_DISC = 1
const CLASS_RANK = ['user', 'deterministic', 'model']

const plain = value => JSON.parse(JSON.stringify(value))
const invalid = detail => catalogError('invalid-request', detail)
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isTime = value => Number.isSafeInteger(value) && value >= 0
const isCount = value => Number.isSafeInteger(value) && value >= 0
const isText = value => typeof value === 'string' && value.length > 0
const optional = (value, check) => value === undefined || check(value)
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const key = (...parts) => parts.join('\n')

export function createFakeCatalogService() {
  const sources = new Map([[USER_SOURCE_ID, USER_SOURCE]])
  const assets = new Map()
  const albums = new Map() // albumId -> Map(assetId -> { disc, track, path })
  const albumOfAsset = new Map()
  const locations = new Map()
  const links = new Map()
  const observations = new Map()
  const observationKeys = new Map()
  const decisions = new Map()
  const consents = Object.fromEntries(CONSENT_KEYS.map(consent => [consent, 'not-asked']))
  // The ledger and the read model. Everything a change set writes goes through put(), so a
  // transaction that throws leaves no trace.
  const overrides = new Map(), locks = new Map(), changeSets = new Map(), suppressions = new Map()
  const projection = new Map() // albumId -> { body, album, version }
  const created = new Map() // albumId -> when the anchor was made
  const meta = new Map([['version', 0], ['changeSets', 0]])
  const dirty = new Set()
  let albumCount = 0, observationCount = 0, decisionCount = 0
  let journal

  const put = (map, entry, value) => {
    if (journal) {
      const had = map.has(entry), previous = map.get(entry)
      journal.push(() => (had ? map.set(entry, previous) : map.delete(entry)))
    }
    if (value === undefined) map.delete(entry)
    else map.set(entry, value)
  }
  const touch = subject => {
    const albumId = subject.kind === 'album' ? subject.id : albumOfAsset.get(subject.id)
    if (albumId !== undefined) dirty.add(albumId)
  }

  const sourceView = source => ({ ...source, consentState: sourceConsentState(source, consents) })
  const requireSource = id => {
    const source = sources.get(id)
    if (!source) throw catalogError('unknown-source', String(id))
    return source
  }
  const requireSubject = subject => {
    if (!isObject(subject) || !SUBJECT_KINDS.includes(subject.kind) || !isCatalogId(subject.id)) throw invalid('subject')
    if (!(subject.kind === 'album' ? albums : assets).has(subject.id)) throw catalogError('unknown-subject', `${subject.kind} ${subject.id}`)
    return { kind: subject.kind, id: subject.id }
  }
  const linkKey = (sourceId, kind, externalId) => key(sourceId, kind, externalId)
  const checkProviderId = request => {
    if (!isObject(request) || !LINK_KINDS.includes(request.kind) || !isText(request.externalId)) throw invalid('provider id')
  }
  // A provider link is an identity claim, so a model source can never make one.
  const requireProvider = sourceId => {
    const source = requireSource(sourceId)
    if (!APPROVING_CLASSES.includes(source.evidenceClass)) throw catalogError('model-cannot-link', source.id)
    return source
  }
  const putLink = (source, kind, externalId, subject, linkedAt) => {
    const link = { sourceId: source.id, kind, externalId, subject, evidenceClass: source.evidenceClass, linkedAt }
    // Only a link that is new, or that names another subject, changes what is projected.
    const current = links.get(linkKey(source.id, kind, externalId))
    links.set(linkKey(source.id, kind, externalId), link)
    if (current?.subject.id !== subject.id) for (const changed of [current?.subject, subject]) if (changed) touch(changed)
    return link
  }
  const newAlbum = createdAt => {
    const id = `album:${++albumCount}`
    put(albums, id, new Map())
    put(created, id, createdAt)
    dirty.add(id)
    return id
  }
  const join = (albumId, assetId, file) => {
    put(albums.get(albumId), assetId, { disc: file.disc, track: file.track, path: file.path })
    put(albumOfAsset, assetId, albumId)
  }

  // Latest decision per (kind, subject, trait). A replay of an older decision changes nothing.
  const decide = (decisionKey, input) => {
    const current = decisions.get(decisionKey)
    if (current && current.decidedAt > input.decidedAt) return current
    const decision = { ...input, id: current?.id ?? `decision:${++decisionCount}`, sourceId: USER_SOURCE_ID }
    put(decisions, decisionKey, decision)
    return decision
  }
  const decisionFor = (kind, subject, trait = '') => decisions.get(key(kind, subject.kind, subject.id, trait))

  // User evidence outranks deterministic, which outranks model. Then the newest wins.
  const outranks = (a, b) => {
    const rank = CLASS_RANK.indexOf(a.evidenceClass) - CLASS_RANK.indexOf(b.evidenceClass)
    return rank ? rank < 0 : a.observedAt > b.observedAt
  }
  const observed = subject => {
    const best = new Map()
    for (const observation of observations.values()) {
      if (observation.subject.kind !== subject.kind || observation.subject.id !== subject.id) continue
      const current = best.get(observation.field)
      if (!current || outranks(observation, current)) best.set(observation.field, observation)
    }
    return best
  }
  const describe = subject => {
    const best = observed(subject)
    const traits = {}, fields = {}
    for (const [field, { value, evidenceClass, sourceId, licence, observedAt }] of best) {
      if (traitOfField(field)) traits[traitOfField(field)] = { value, provenance: 'estimated', sourceId, licence, observedAt }
      else fields[field] = { value, evidenceClass, sourceId, licence, observedAt }
    }
    // A field set by an applied change set stands in front of what the sources observed.
    for (const override of overrides.values()) {
      if (override.subject.kind !== subject.kind || override.subject.id !== subject.id) continue
      const { value, evidenceClass, sourceId, licence, observedAt, changeSetId } = override.value
      fields[override.field] = { value, evidenceClass, sourceId, licence, observedAt, changeSetId }
    }
    for (const trait of TRAIT_NAMES) {
      const decision = decisionFor('trait', subject, trait)
      if (decision?.value !== undefined) traits[trait] = { value: decision.value, provenance: 'hand-set', sourceId: USER_SOURCE_ID, licence: USER_SOURCE.licence, observedAt: decision.decidedAt }
    }
    return { favorite: decisionFor('favorite', subject)?.value === true, traits, fields }
  }
  const linksOf = subject => [...links.values()].filter(link => link.subject.kind === subject.kind && link.subject.id === subject.id)
  const locationsOf = assetId => [...locations.values()].filter(location => location.assetId === assetId)
  const playbackLinksOf = (assetId, found) => {
    const live = new Map()
    for (const { availability, providerSourceId, providerTrackId } of found) {
      if (availability !== 'available' || providerTrackId === undefined) continue
      const id = linkKey(providerSourceId, 'track', providerTrackId)
      const link = links.get(id)
      if (link?.subject.id === assetId) live.set(id, { sourceId: providerSourceId, externalId: providerTrackId })
    }
    return [...live.values()].sort((a, b) => compareText(a.sourceId, b.sourceId) || compareText(a.externalId, b.externalId))
  }
  const availabilityOf = found => {
    const states = found.map(location => location.availability)
    return states.includes('available') ? 'available' : states.includes('unavailable') ? 'unavailable' : 'missing'
  }
  const assetView = asset => {
    const found = locationsOf(asset.id)
    const subject = { kind: 'asset', id: asset.id }
    return {
      ...asset, albumId: albumOfAsset.get(asset.id), ...describe(subject), availability: availabilityOf(found),
      analysisAllowed: found.length > 0 && found.every(location => sources.get(location.sourceId).policy.analysisAllowed),
      locations: found.map(({ providerSourceId, providerTrackId, ...location }) => location),
      links: linksOf(subject), playbackLinks: playbackLinksOf(asset.id, found),
    }
  }
  const albumView = id => {
    const subject = { kind: 'album', id }
    const placements = albums.get(id)
    const numbering = trackNumbering([...placements.keys()], recordsByKeys)
    const members = [...placements].map(([assetId, place]) => {
      const corrected = numbering.get(assetId)
      return { assetId, ...place, disc: corrected?.disc ?? place.disc, track: corrected?.track ?? place.track }
    })
    members.sort((a, b) => (a.disc ?? FIRST_DISC) - (b.disc ?? FIRST_DISC) || (a.track ?? Infinity) - (b.track ?? Infinity) || compareText(a.path, b.path))
    const states = new Set(members.map(member => availabilityOf(locationsOf(member.assetId))))
    const availability = states.size > 1 && states.has('available') ? 'partial' : availabilityOf([...states].map(state => ({ availability: state })))
    const tracks = members.map(({ assetId, disc, track }, position) => ({ id: `occurrence:${id}:${assetId}`, albumId: id, assetId, position, disc, track }))
    return { id, ...describe(subject), availability, tracks, links: linksOf(subject) }
  }

  const checkSnapshot = snapshot => {
    if (!isObject(snapshot) || !isTime(snapshot.observedAt) || typeof snapshot.rootAvailable !== 'boolean' || typeof snapshot.complete !== 'boolean' || !Array.isArray(snapshot.files)) throw invalid('scan snapshot')
    for (const file of snapshot.files) {
      const valid = isObject(file) && isText(file.path) && isCatalogId(file.contentHash) && isCount(file.size) && optional(file.tags, isScanTags)
        && optional(file.duration, value => Number.isFinite(value) && value >= 0) && optional(file.disc, isCount) && optional(file.track, isCount)
        && optional(file.providerTrackId, isText) && optional(file.providerAlbumId, isText)
      if (!valid) throw invalid('scan file')
      if ((file.providerTrackId ?? file.providerAlbumId) !== undefined && snapshot.providerSourceId === undefined) throw invalid('provider ids need providerSourceId')
    }
  }
  // Decides the anchor of every file that names a provider album, one provider album at a time.
  // A known provider ID keeps its anchor. An unknown one that now covers every member of
  // exactly one anchor is a provider re-ID of that anchor. Anything else gets a new anchor
  // for the assets that have none, and is reported as a conflict for those that do.
  const anchor = (provider, observedAt, groups, conflicts) => {
    const touched = new Set()
    for (const [providerAlbumId, files] of groups) {
      const linked = links.get(linkKey(provider.id, 'album', providerAlbumId))?.subject.id
      const anchored = new Set(files.map(file => albumOfAsset.get(file.assetId)).filter(id => id !== undefined))
      const [only] = anchored
      const ids = new Set(files.map(file => file.assetId))
      const reId = linked === undefined && anchored.size === 1 && [...albums.get(only).keys()].every(assetId => ids.has(assetId))
      const loose = files.filter(file => !albumOfAsset.has(file.assetId))
      const albumId = linked ?? (reId ? only : loose.length ? newAlbum(observedAt) : undefined)
      if (albumId !== undefined && linked === undefined) putLink(provider, 'album', providerAlbumId, { kind: 'album', id: albumId }, observedAt)
      for (const file of files) {
        const current = albumOfAsset.get(file.assetId)
        if (current === undefined || current === albumId) join(albumId, file.assetId, file)
        else conflicts.push({ assetId: file.assetId, albumId: current, providerAlbumId, linkedAlbumId: albumId })
        touched.add(albumOfAsset.get(file.assetId))
      }
    }
    return [...touched]
  }

  const service = {
    registerSource(input) {
      const { id, kind, label, evidenceClass, licence, policy } = validateSource(input)
      const current = sources.get(id)
      if (current && (current.kind !== kind || current.evidenceClass !== evidenceClass || current.licence !== licence)) throw catalogError('source-identity-immutable', id)
      const source = { id, kind, label, evidenceClass, licence, policy: { analysisAllowed: policy.analysisAllowed, network: policy.network, consent: policy.consent } }
      if (id !== USER_SOURCE_ID) sources.set(id, source)
      return sourceView(sources.get(id))
    },
    listSources: () => ({ sources: [...sources.values()].map(sourceView) }),
    ingestScan(snapshot) {
      checkSnapshot(snapshot)
      const source = requireSource(snapshot.sourceId)
      const provider = snapshot.providerSourceId === undefined ? undefined : requireProvider(snapshot.providerSourceId)
      const own = [...locations.values()].filter(location => location.sourceId === source.id)
      for (const location of own) touch({ kind: 'asset', id: location.assetId })
      if (!snapshot.rootAvailable) {
        for (const location of own) location.availability = 'unavailable'
        return { assetIds: [], albumIds: [], conflicts: [] }
      }
      const seen = new Set(), groups = new Map(), assetIds = [], tagged = []
      for (const file of snapshot.files) {
        const assetId = `asset:${file.contentHash}:${file.size}`
        tagged.push({ assetId, tags: file.tags })
        const duration = file.duration ?? assets.get(assetId)?.duration
        assets.set(assetId, { id: assetId, contentHash: file.contentHash, size: file.size, duration })
        locations.set(key(source.id, file.path), { assetId, sourceId: source.id, path: file.path, availability: 'available', seenAt: snapshot.observedAt,
          providerSourceId: provider?.id, providerTrackId: file.providerTrackId })
        seen.add(file.path)
        assetIds.push(assetId)
        if (file.providerTrackId !== undefined) putLink(provider, 'track', file.providerTrackId, { kind: 'asset', id: assetId }, snapshot.observedAt)
        if (file.providerAlbumId !== undefined) groups.set(file.providerAlbumId, [...groups.get(file.providerAlbumId) ?? [], { ...file, assetId }])
      }
      if (snapshot.complete) {
        for (const location of own) if (!seen.has(location.path)) location.availability = 'missing'
      }
      const conflicts = []
      const albumIds = provider ? anchor(provider, snapshot.observedAt, groups, conflicts) : []
      for (const { subject, field, value } of tagObservations(tagged, assetId => albumOfAsset.get(assetId))) observeTag(source, subject, field, value, snapshot.observedAt)
      for (const assetId of assetIds) touch({ kind: 'asset', id: assetId })
      return { assetIds, albumIds, conflicts }
    },
    linkProvider(request) {
      checkProviderId(request)
      const source = requireProvider(request.sourceId)
      if (!isTime(request.linkedAt)) throw invalid('linkedAt')
      const subject = requireSubject(request.subject)
      if ((request.kind === 'album') !== (subject.kind === 'album')) throw invalid('link kind does not match its subject')
      const current = links.get(linkKey(source.id, request.kind, request.externalId))
      if (current && current.subject.id !== subject.id) throw catalogError('link-conflict', `${request.externalId} is linked to ${current.subject.id}`)
      return current ?? putLink(source, request.kind, request.externalId, subject, request.linkedAt)
    },
    resolveProviderId(request) {
      checkProviderId(request)
      requireSource(request.sourceId)
      return { subject: links.get(linkKey(request.sourceId, request.kind, request.externalId))?.subject }
    },
    recordObservation(input) {
      if (!isObject(input) || !isText(input.field) || input.value === undefined || !isTime(input.observedAt) || !optional(input.derivedFrom, Array.isArray)) throw invalid('observation')
      const source = requireSource(input.sourceId)
      const subject = requireSubject(input.subject)
      if (input.field.startsWith(TRAIT_FIELD_PREFIX) && !(traitOfField(input.field) && isTraitValue(input.value))) throw invalid('trait observation')
      const inputs = (input.derivedFrom ?? []).map(id => {
        if (!observations.has(id)) throw catalogError('unknown-observation', String(id))
        return observations.get(id)
      })
      const observationKey = key(source.id, subject.kind, subject.id, input.field, input.observedAt)
      const id = observationKeys.get(observationKey) ?? `observation:${++observationCount}`
      const observation = {
        id, sourceId: source.id, subject, field: input.field, value: input.value, observedAt: input.observedAt,
        derivedFrom: inputs.length ? inputs.map(item => item.id) : undefined,
        evidenceClass: propagateEvidenceClass(source.evidenceClass, inputs.map(item => item.evidenceClass)),
        licence: propagateLicence([source.licence, ...inputs.map(item => item.licence)]),
      }
      observationKeys.set(observationKey, id)
      observations.set(id, observation)
      touch(subject)
      return observation
    },
    recordUserDecision(input) {
      if (!isObject(input) || !isTime(input.decidedAt)) throw invalid('decision')
      const { decidedAt } = input
      if (input.kind === 'consent') {
        if (!CONSENT_KEYS.includes(input.consent) || !CONSENT_VALUES.includes(input.value)) throw invalid('consent')
        const decision = decide(key('consent', input.consent), { kind: 'consent', consent: input.consent, value: input.value, decidedAt })
        consents[input.consent] = decision.value
        return decision
      }
      if (input.kind === 'favorite') {
        if (typeof input.value !== 'boolean') throw invalid('favorite')
        const subject = requireSubject(input.subject)
        touch(subject)
        return decide(key('favorite', subject.kind, subject.id, ''), { kind: 'favorite', subject, value: input.value, decidedAt })
      }
      if (input.kind !== 'trait' || !TRAIT_NAMES.includes(input.trait) || !optional(input.value, isTraitValue)) throw invalid('decision')
      const subject = requireSubject(input.subject)
      touch(subject)
      return decide(key('trait', subject.kind, subject.id, input.trait), { kind: 'trait', subject, trait: input.trait, value: input.value, decidedAt })
    },
    getAlbum: request => ({ album: albums.has(request?.albumId) ? albumView(request.albumId) : undefined }),
    getAsset: request => ({ asset: assets.has(request?.assetId) ? assetView(assets.get(request.assetId)) : undefined }),
    getPlaybackLinks(request) {
      const ids = request?.assetIds
      if (!Array.isArray(ids) || ids.length > MAX_PLAYBACK_LINKS || !ids.every(isCatalogId)) throw invalid('playback assets')
      const links = Object.fromEntries([...new Set(ids)].map(id => [id, playbackLinksOf(id, locationsOf(id))]))
      return { links, version: meta.get('version') }
    },
    listAlbums(request = {}) {
      const { offset = 0, limit = DEFAULT_ALBUM_PAGE } = request
      if (!isCount(offset) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ALBUM_PAGE) throw invalid('album page')
      const ids = [...albums.keys()].filter(id => albums.get(id).size > 0)
      return { albums: ids.slice(offset, offset + limit).map(albumView), total: ids.length }
    },
    getConsent: () => ({ ...consents }),
    setConsent(request) {
      service.recordUserDecision({ kind: 'consent', consent: request?.consent, value: request?.value, decidedAt: request?.decidedAt })
      return { ...consents }
    },
  }
  // A tag is observed again only when the scanned source says something new.
  const observeTag = (source, subject, field, value, observedAt) => {
    let latest
    for (const observation of observations.values()) {
      const same = observation.sourceId === source.id && observation.subject.kind === subject.kind && observation.subject.id === subject.id && observation.field === field
      if (same && (!latest || observation.observedAt > latest.observedAt)) latest = observation
    }
    if (latest?.value !== value) service.recordObservation({ sourceId: source.id, subject, field, value, observedAt })
  }

  const lockedFields = subject => [...locks.values()].filter(lock => lock.subject.kind === subject.kind && lock.subject.id === subject.id).map(lock => lock.field)
  const project = id => projectAlbum(albumView(id), assetId => {
    const found = locationsOf(assetId)
    const subject = { kind: 'asset', id: assetId }
    return { duration: assets.get(assetId).duration, fields: describe(subject).fields, availability: availabilityOf(found), playbackLinks: playbackLinksOf(assetId, found) }
  }, lockedFields({ kind: 'album', id }), created.get(id))
  // Brings the projection of every touched album up to date. The version moves only when a
  // projected album really changed.
  const flush = () => {
    let version = meta.get('version'), moved = false
    for (const id of dirty) {
      if (!albums.has(id)) continue
      const body = JSON.stringify(project(id))
      if (projection.get(id)?.body === body) continue
      if (!moved) version++
      moved = true
      put(projection, id, { body, album: JSON.parse(body), version })
    }
    dirty.clear()
    if (moved) put(meta, 'version', version)
    return version
  }
  const transaction = body => {
    if (journal) return body()
    journal = []
    try {
      const result = body()
      flush()
      return result
    } catch (error) {
      for (const revert of journal.reverse()) revert()
      dirty.clear()
      throw error
    } finally { journal = undefined }
  }
  const listed = () => [...albums.keys()].map(id => projection.get(id)).filter(entry => entry && entry.album.trackCount > 0)
  const recordsByKeys = keys => [...changeSets.values()].filter(record => record.keys.some(item => keys.includes(item))).sort((a, b) => a.seq - b.seq)

  const ledger = createLedger({
    transaction, flush, touch, requireSubject,
    version: () => meta.get('version'),
    subjectVersion: subject => projection.get(subject.kind === 'album' ? subject.id : albumOfAsset.get(subject.id))?.version ?? 0,
    findSource: id => sources.get(id),
    findObservation: id => observations.get(id),
    memberOf: assetId => {
      const albumId = albumOfAsset.get(assetId)
      return albumId === undefined ? undefined : { albumId, ...albums.get(albumId).get(assetId) }
    },
    membersOf: albumId => [...albums.get(albumId)].map(([assetId, place]) => ({ assetId, albumId, ...place })),
    setMember(assetId, place) {
      const current = albumOfAsset.get(assetId)
      const scanned = current === undefined ? undefined : albums.get(current).get(assetId)
      if (current !== undefined) put(albums.get(current), assetId, undefined)
      put(albumOfAsset, assetId, place?.albumId)
      if (place) put(albums.get(place.albumId), assetId, { disc: scanned?.disc, track: scanned?.track, path: place.path })
    },
    newAlbum,
    albumLinks: albumId => linksOf({ kind: 'album', id: albumId }).filter(link => link.kind === 'album'),
    findLink: (sourceId, kind, externalId) => links.get(linkKey(sourceId, kind, externalId)),
    // A link is projected with its subject, so the album it leaves and the one it joins both change.
    setLink(link) {
      const current = links.get(linkKey(link.sourceId, link.kind, link.externalId))
      if (current) touch(current.subject)
      put(links, linkKey(link.sourceId, link.kind, link.externalId), link)
      touch(link.subject)
    },
    removeLink(sourceId, kind, externalId) {
      const current = links.get(linkKey(sourceId, kind, externalId))
      if (current) touch(current.subject)
      put(links, linkKey(sourceId, kind, externalId), undefined)
    },
    fieldValue: (subject, field) => describe(subject).fields[field]?.value,
    decision(kind, subject, trait) {
      const decision = decisionFor(kind, subject, trait)
      return decision && { value: decision.value, decidedAt: decision.decidedAt }
    },
    setDecision(kind, subject, trait, value, decidedAt) {
      const decisionKey = key(kind, subject.kind, subject.id, trait)
      const id = decisions.get(decisionKey)?.id ?? `decision:${++decisionCount}`
      put(decisions, decisionKey, { kind, subject, trait, value, decidedAt, id, sourceId: USER_SOURCE_ID })
    },
    override: (subject, field) => overrides.get(key(subject.kind, subject.id, field))?.value,
    setOverride: (subject, field, value) => put(overrides, key(subject.kind, subject.id, field), value && { subject, field, value }),
    lock: (subject, field) => locks.get(key(subject.kind, subject.id, field))?.changeSetId,
    setLock: (subject, field, changeSetId) => put(locks, key(subject.kind, subject.id, field), changeSetId && { subject, field, changeSetId }),
    // Records are copied in and out, as a database would.
    findChangeSet: id => (changeSets.has(id) ? plain(changeSets.get(id)) : undefined),
    insertChangeSet(record) {
      record.seq = meta.get('changeSets') + 1
      put(meta, 'changeSets', record.seq)
      put(changeSets, record.id, plain(record))
    },
    updateChangeSet: record => put(changeSets, record.id, plain(record)),
    changeSetsByKeys: keys => plain(recordsByKeys(keys)),
    changeSetPage({ offset, limit }) {
      const records = [...changeSets.values()].sort((a, b) => b.seq - a.seq)
      return { records: plain(records.slice(offset, offset + limit)), total: records.length }
    },
    suppression: (author, fingerprint) => suppressions.get(key(author, fingerprint)),
    setSuppression: (author, fingerprint, changeSetId) => put(suppressions, key(author, fingerprint), changeSetId),
  })

  Object.assign(service, ledger, {
    listCatalogAlbums(request = {}) {
      const { offset = 0, limit = DEFAULT_ALBUM_PAGE, sort = 'artist', artist } = request
      if (!isCount(offset) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ALBUM_PAGE || !CATALOG_SORTS.includes(sort)
        || !optional(artist, value => isText(value) && value.trim() && value.length <= MAX_TAG_LENGTH)) throw invalid('album page')
      const entries = artist === undefined ? listed() : listed().filter(({ album }) => searchRows(album).some(row => row.artist === artist))
      if (sort !== 'added') {
        const compare = compareAlbums(sort)
        entries.sort((a, b) => compare(a.album, b.album))
      }
      return { albums: entries.slice(offset, offset + limit).map(entry => albumSummary(entry.album, entry.version)), total: entries.length, version: meta.get('version') }
    },
    getCatalogAlbum(request) {
      const entry = projection.get(request?.albumId)
      return { album: entry && albumDetail(entry.album, entry.version), version: meta.get('version') }
    },
    searchCatalog(request) {
      const { terms, kinds, limit, offset } = normalSearch(request)
      const entries = listed()
      const rows = entries.flatMap(entry => searchRows(entry.album).map(row => ({ ...row, entry })))
      const found = rows.filter(row => matchesTerms(terms, row.title, row.artist))
      const compare = compareAlbums('artist')
      const albumsFound = found.filter(row => row.kind === 'album').map(row => row.entry).sort((a, b) => compare(a.album, b.album))
      const tracks = found.filter(row => row.kind === 'track').map(row => row.entry.album.tracks.find(track => track.id === row.id)).sort(compareTracks)
      const byArtist = new Map()
      for (const row of rows) if (matchesTerms(terms, row.artist)) byArtist.set(row.artist, (byArtist.get(row.artist) ?? new Set()).add(row.albumId))
      const artists = [...byArtist].map(([name, ids]) => ({ name, albumCount: ids.size })).sort(compareArtists)
      const only = (kind, values) => (kinds.includes(kind) ? values.slice(offset, offset + limit) : [])
      return {
        albums: only('album', albumsFound).map(entry => albumSummary(entry.album, entry.version)), artists: only('artist', artists), tracks: only('track', tracks),
        version: meta.get('version'),
      }
    },
    rebuildProjections() {
      const started = Date.now()
      for (const id of albums.keys()) dirty.add(id)
      const version = flush()
      const entries = listed()
      return { albums: entries.length, tracks: entries.reduce((total, entry) => total + entry.album.trackCount, 0), version, ms: Date.now() - started }
    },
    verifyProjections() {
      const differing = [...albums.keys()].filter(id => projection.get(id)?.body !== JSON.stringify(project(id)))
      return { consistent: differing.length === 0, albums: albums.size, differing: differing.slice(0, MAX_REPORTED_DIFFERENCES) }
    },
  })
  // Every call is asynchronous and answers with a fresh JSON copy, as it will across IPC.
  // The ledger opens its own transactions, because a refused undo must roll back alone.
  return Object.fromEntries(Object.entries(service).map(([name, method]) => {
    const run = Object.hasOwn(ledger, name) ? method : request => transaction(() => method(request))
    return [name, async request => plain(run(request === undefined ? undefined : plain(request)))]
  }))
}

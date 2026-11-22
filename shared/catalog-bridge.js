// What the frontend may ask of the identity spine. Decisions are keyed by the provider's album
// ID or by the anchor, the read model and the review by the anchor. Works over any
// CatalogService. Types: catalog-bridge.d.ts.
import { validateToolInput } from './tool-contracts.js'
import { CONSENT_KEYS, FAVORITE_FIELD, TRAIT_NAMES, USER_SOURCE_ID, isCatalogId, isTraitValue, traitField, traitOfField } from './catalog-rules.js'
import { MAX_SEARCH_LIMIT, MAX_TAG_LENGTH } from './catalog-projection.js'
import { SPOTIFY_CONSENT } from './spotify-source.js'

// The consents the window may decide. Provider sign-ins own theirs: Spotify's follows sign-in and sign-out in the main process.
const WINDOW_CONSENT_KEYS = CONSENT_KEYS.filter(key => key !== SPOTIFY_CONSENT)

export const NAVIDROME_SOURCE_ID = 'navidrome'
// IPC operation name -> bridge method.
export const CATALOG_BRIDGE_METHODS = Object.freeze({
  albums: 'albums', 'set-trait': 'setTrait', 'set-favorite': 'setFavorite', migrate: 'migrate', consent: 'consent', 'set-consent': 'setConsent',
  activity: 'activity', undo: 'undo', tool: 'tool', 'estimated-traits': 'estimatedTraits',
  'similar-albums': 'similarAlbums',
  'catalog-albums': 'catalogAlbums', 'catalog-album': 'catalogAlbum', 'catalog-search': 'catalogSearch', 'playback-links': 'playbackLinks',
  'album-review': 'albumReview', 'set-field': 'setField', 'lock-field': 'lockField', 'undo-field': 'undoField',
})
// The operations after which every window shows something else.
export const CATALOG_CHANGING_OPERATIONS = Object.freeze(['undo', 'set-field', 'lock-field', 'undo-field'])
// The album fields a user may correct, lock and take back in the album details.
export const REVIEW_FIELDS = Object.freeze(['title', 'artist', 'year', 'genre'])
export const MAX_ALBUM_PAGE = 500
export const MAX_PLAYBACK_LINKS = 500
export const MAX_YEAR = 9999
// Read tracks last so the response version identifies their stream links.
const SEARCH_PAGES = { albums: 'album', artists: 'artist', tracks: 'track' }
// Sources that only report what the files say. Anything else that sets a field is a route.
const TAG_SOURCE_KINDS = ['local-folder', 'navidrome']
export const ACTIVITY_PAGE = 100
export const MAX_ACTIVITY_PAGE = 200
// Edits of one trait of one album that follow each other this closely are one gesture, and one receipt.
export const TRAIT_COALESCE_MS = 3000
const CHANGE_ID_PREFIX = 'change:'
const USER_AUTHOR = { kind: 'user' }
const UNDONE_STATES = ['undone', 'suppressed']
const BLOCKED_DETAIL = 'Undo the later change to this first.'
const SUPPRESSED_DETAIL = 'Kept will not make this change again.'
export const MAX_MIGRATION_ALBUMS = 100000
const MAX_PROVIDER_ID_LENGTH = 256
const CONSENT_VALUES = ['granted', 'denied']

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isProviderId = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_PROVIDER_ID_LENGTH
const isTime = value => Number.isSafeInteger(value) && value > 0
const isTraits = value => isObject(value) && Object.entries(value).every(([trait, level]) => TRAIT_NAMES.includes(trait) && isTraitValue(level))
const isCount = value => Number.isSafeInteger(value) && value >= 0
const isLimit = (value, most) => Number.isSafeInteger(value) && value >= 1 && value <= most
const isSearchPage = page => page === undefined || (isObject(page) && isCount(page.offset) && isLimit(page.limit, MAX_SEARCH_LIMIT))
// An album is named by the provider's ID or by its anchor, never both.
const isAlbumTarget = request => (request.albumId === undefined ? isProviderId(request.providerAlbumId) : request.providerAlbumId === undefined && isCatalogId(request.albumId))
const isFieldValue = (field, value) => (field === 'year' ? isLimit(value, MAX_YEAR) : typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TAG_LENGTH)
const isChangeId = value => value === undefined || isCatalogId(value)
const isMigrationAlbum = album => isObject(album) && isProviderId(album.providerAlbumId)
  && (album.favorite === undefined || typeof album.favorite === 'boolean') && (album.traits === undefined || isTraits(album.traits))

// Throws unless the arguments of an IPC call are well formed. Returns the request.
export function validateCatalogBridgeRequest(method, args) {
  const [request] = args
  const fail = () => { throw new Error('Invalid catalog request') }
  if (!Object.hasOwn(CATALOG_BRIDGE_METHODS, method)) throw new Error('Unknown catalog operation')
  if (method === 'albums' || method === 'consent' || method === 'estimated-traits') return request === undefined ? undefined : fail()
  if ((method === 'activity' || method === 'catalog-albums') && request === undefined) return undefined
  if (!isObject(request)) fail()
  if (method === 'catalog-albums' && !((request.offset === undefined || isCount(request.offset)) && (request.limit === undefined || isLimit(request.limit, MAX_ALBUM_PAGE))
    && (request.sort === undefined || typeof request.sort === 'string')
    && (request.artist === undefined || (typeof request.artist === 'string' && request.artist.trim() && request.artist.length <= MAX_TAG_LENGTH)))) fail()
  if (['catalog-album', 'album-review', 'set-field', 'lock-field', 'undo-field'].includes(method) && !isCatalogId(request.albumId)) fail()
  if (method === 'similar-albums' && (!isCatalogId(request.albumId) || Object.keys(request).length !== 1)) fail()
  if (method === 'catalog-search' && !(typeof request.query === 'string' && Object.keys(SEARCH_PAGES).every(kind => isSearchPage(request[kind])))) fail()
  if (method === 'playback-links' && !(Array.isArray(request.assetIds) && request.assetIds.length <= MAX_PLAYBACK_LINKS && request.assetIds.every(isCatalogId))) fail()
  if (['set-field', 'lock-field', 'undo-field'].includes(method) && !REVIEW_FIELDS.includes(request.field)) fail()
  if (method === 'set-field' && !(isFieldValue(request.field, request.value) && isChangeId(request.changeId))) fail()
  if (method === 'lock-field' && !(typeof request.locked === 'boolean' && isChangeId(request.changeId))) fail()
  if (method === 'undo' && !(request.operations === undefined || (Array.isArray(request.operations) && request.operations.length > 0 && request.operations.every(isCount)))) fail()
  if (method === 'activity' && !((request.offset === undefined || isCount(request.offset))
    && (request.limit === undefined || isLimit(request.limit, MAX_ACTIVITY_PAGE)))) fail()
  if (method === 'undo' && !isCatalogId(request.id)) fail()
  // The tool contracts name the first violation, which the caller can act on.
  if (method === 'tool') { if (Object.keys(request).some(key => key !== 'name' && key !== 'input')) fail(); validateToolInput(request.name, request.input) }
  if (method === 'set-trait' && !(isAlbumTarget(request) && TRAIT_NAMES.includes(request.trait) && (request.value === undefined || isTraitValue(request.value)) && isChangeId(request.changeId))) fail()
  if (method === 'set-favorite' && !(isAlbumTarget(request) && typeof request.value === 'boolean' && isChangeId(request.changeId))) fail()
  if (method === 'set-consent' && !(WINDOW_CONSENT_KEYS.includes(request.consent) && CONSENT_VALUES.includes(request.value))) fail()
  if (method === 'migrate' && !(isTime(request.decidedAt) && Array.isArray(request.albums) && request.albums.length <= MAX_MIGRATION_ALBUMS && request.albums.every(isMigrationAlbum))) fail()
  return request
}

// One line for a receipt: what the first operation did, in the user's words.
function describeOperation(operation, nameOf) {
  const { kind } = operation
  if (kind === 'set-field') {
    const trait = traitOfField(operation.field), name = nameOf(operation.subject)
    if (operation.field === FAVORITE_FIELD) return { summary: operation.value ? `Added ${name} to favourites` : `Removed ${name} from favourites` }
    if (trait) return { summary: operation.value === undefined ? `Cleared ${trait} on ${name}` : `Set ${trait} to ${Math.round(operation.value)} on ${name}` }
    if (operation.value === undefined) return { summary: `Cleared the ${operation.field} of ${name}` }
    return { summary: `Changed the ${operation.field} of ${name}`, detail: typeof operation.value === 'object' ? undefined : String(operation.value) }
  }
  if (kind === 'lock-field') return { summary: `${operation.locked ? 'Locked' : 'Unlocked'} the ${operation.field} of ${nameOf(operation.subject)}` }
  if (kind === 'merge-albums') return { summary: `Merged ${operation.from.length + 1} albums into ${nameOf({ kind: 'album', id: operation.into })}` }
  if (kind === 'split-album') return { summary: `Split ${operation.assetIds.length === 1 ? 'a track' : `${operation.assetIds.length} tracks`} out of ${nameOf({ kind: 'album', id: operation.albumId })}` }
  if (kind === 'move-track') return { summary: `Moved a track to ${nameOf({ kind: 'album', id: operation.albumId })}` }
  return { summary: `Linked ${nameOf(operation.subject)} to the music server` }
}

const capital = text => text.charAt(0).toUpperCase() + text.slice(1)
const shown = value => (value === undefined || typeof value === 'object' ? undefined : typeof value === 'number' ? String(Math.round(value)) : String(value))
const yesNo = value => (value === true ? 'Yes' : 'No')
const lockState = locked => (locked ? 'Locked' : 'Open to changes')
// One operation as the comparison shows it: what it is, and the value before and after.
function compareOperation({ operation, before }, nameOf) {
  const { kind } = operation
  if (kind === 'set-field') {
    const trait = traitOfField(operation.field)
    if (operation.field === FAVORITE_FIELD) return { label: 'Favourite', before: yesNo(before), after: yesNo(operation.value) }
    return { label: capital(trait ?? operation.field), before: shown(before), after: shown(operation.value) }
  }
  if (kind === 'lock-field') return { label: `Lock on the ${operation.field}`, before: lockState(!operation.locked), after: lockState(operation.locked) }
  const albumName = id => nameOf({ kind: 'album', id })
  if (kind === 'merge-albums') return { label: 'Albums', before: [operation.into, ...operation.from].map(albumName).join(' + '), after: albumName(operation.into) }
  if (kind === 'split-album') {
    const count = operation.assetIds.length
    return { label: 'Tracks', before: albumName(operation.albumId), after: `${albumName(operation.albumId)} and a new album of ${count === 1 ? '1 track' : `${count} tracks`}` }
  }
  if (kind === 'move-track') return { label: 'Track', after: albumName(operation.albumId) }
  return { label: 'Music server link', after: nameOf(operation.subject) }
}

export function createCatalogBridge(service, { now = Date.now, providerSourceId = NAVIDROME_SOURCE_ID, tools, estimates, soundSimilarity, newId = () => `${CHANGE_ID_PREFIX}${globalThis.crypto.randomUUID()}` } = {}) {
  // The anchor of a provider album, once a scan has linked it. Before the first scan the provider is not registered.
  const anchorOf = async providerAlbumId => {
    try { return (await service.resolveProviderId({ sourceId: providerSourceId, kind: 'album', externalId: providerAlbumId })).subject }
    catch (error) {
      if (String(error.message).startsWith('unknown-source:')) return undefined
      throw error
    }
  }
  // The trait edit this bridge committed last, which the next one may continue.
  let lastEdit
  const commitField = async ({ providerAlbumId, albumId, changeId }, field, value) => {
    const subject = albumId === undefined ? await anchorOf(providerAlbumId) : { kind: 'album', id: albumId }
    if (!subject) return { applied: false }
    const committedAt = now()
    const continues = traitOfField(field) && lastEdit?.subjectId === subject.id && lastEdit.field === field && committedAt - lastEdit.at <= TRAIT_COALESCE_MS
    const result = await service.commitChangeSet({
      id: changeId ?? newId(), author: USER_AUTHOR, operations: [{ kind: 'set-field', subject, field, value }], committedAt, amends: continues ? lastEdit.id : undefined,
    })
    if (result.status === 'applied' && traitOfField(field)) lastEdit = { id: result.changeSet.id, subjectId: subject.id, field, at: committedAt }
    return { applied: result.status === 'applied' }
  }
  const decide = async (providerAlbumId, decisions) => {
    const subject = await anchorOf(providerAlbumId)
    if (!subject) return { applied: false }
    for (const decision of decisions) await service.recordUserDecision({ ...decision, subject })
    return { applied: true }
  }
  return {
    // Read from the projection: one small row per album, however large the library.
    async albums() {
      const albums = {}
      for (let offset = 0; ; offset += MAX_ALBUM_PAGE) {
        const page = await service.listCatalogAlbums({ offset, limit: MAX_ALBUM_PAGE, sort: 'added' })
        for (const album of page.albums) {
          const state = { albumId: album.id, favorite: album.favorite, availability: album.availability, traits: album.traits }
          for (const link of album.links) if (link.sourceId === providerSourceId) albums[link.externalId] = state
        }
        if (!page.albums.length || offset + page.albums.length >= page.total) return { albums }
      }
    },
    // The read model the window browses: albums in the order asked for, one album with its
    // tracks, and a search that pages each kind on its own.
    catalogAlbums: (request = {}) => service.listCatalogAlbums(request),
    catalogAlbum: ({ albumId }) => service.getCatalogAlbum({ albumId }),
    async catalogSearch({ query, ...pages }) {
      const result = { albums: [], artists: [], tracks: [], trackAlbums: [], version: 0 }
      for (const [name, kind] of Object.entries(SEARCH_PAGES)) {
        if (!pages[name]) continue
        const found = await service.searchCatalog({ query, kinds: [kind], offset: pages[name].offset, limit: pages[name].limit })
        result[name] = found[name]
        result.version = found.version
      }
      // A track is shown with its album, also when the album itself did not match.
      const known = new Set(result.albums.map(album => album.id))
      for (const { albumId } of result.tracks) {
        if (known.has(albumId)) continue
        known.add(albumId)
        const { album } = await service.getCatalogAlbum({ albumId })
        if (album) { const { tracks, ...summary } = album; result.trackAlbums.push(summary) }
      }
      return result
    },
    // Current stream IDs for tracks the window kept from an earlier run.
    playbackLinks: request => service.getPlaybackLinks(request),
    // Where each reviewed field of an album comes from, and what may be done with it.
    async albumReview({ albumId }) {
      const [{ album }, { album: projected, version }, { sources }] = await Promise.all([service.getAlbum({ albumId }), service.getCatalogAlbum({ albumId }), service.listSources()])
      if (!album) return { fields: [], version }
      const kinds = new Map(sources.map(source => [source.id, source.kind]))
      const fields = []
      for (const field of REVIEW_FIELDS) {
        const current = album.fields[field], locked = projected?.locks.includes(field) ?? false
        const value = typeof current?.value === 'string' || typeof current?.value === 'number' ? current.value : undefined
        if (value === undefined) { fields.push({ field, locked, undoable: false }); continue }
        const author = current.changeSetId === undefined ? undefined : (await service.getChangeSet({ id: current.changeSetId })).changeSet?.author
        const byRoute = author ? author.kind !== 'user' : current.sourceId !== USER_SOURCE_ID && !TAG_SOURCE_KINDS.includes(kinds.get(current.sourceId))
        const origin = byRoute ? 'route' : author || current.sourceId === USER_SOURCE_ID ? 'user' : 'tags'
        fields.push({ field, value, origin, by: byRoute ? author?.route ?? author?.id ?? current.sourceId : undefined, locked, undoable: current.changeSetId !== undefined })
      }
      return { fields, version }
    },
    // A correction by the user: a change set of its own, so it has a receipt and an Undo.
    async setField({ albumId, field, value, changeId }) {
      const result = await service.commitChangeSet({
        id: changeId ?? newId(), author: USER_AUTHOR, operations: [{ kind: 'set-field', subject: { kind: 'album', id: albumId }, field, value: typeof value === 'string' ? value.trim() : value }], committedAt: now(),
      })
      return result.status === 'applied' ? { applied: true } : { applied: false, reason: result.reason }
    },
    // A locked field refuses every automated change. The user is not held by it.
    async lockField({ albumId, field, locked, changeId }) {
      const result = await service.commitChangeSet({
        id: changeId ?? newId(), author: USER_AUTHOR, operations: [{ kind: 'lock-field', subject: { kind: 'album', id: albumId }, field, locked }], committedAt: now(),
      })
      return result.status === 'applied' ? { applied: true } : { applied: false, reason: result.reason }
    },
    // Takes back the newest change to one field, whoever made it.
    async undoField({ albumId, field }) {
      const result = await service.undoField({ subject: { kind: 'album', id: albumId }, field, undoneAt: now() })
      return result.status === 'undone' ? { status: 'undone' } : { status: 'blocked', reason: result.reason, blockedBy: result.blockedBy }
    },
    // A hand-set trait is a change set, so it has a receipt and an Undo. The window may name
    // the change itself: sending the same changeId again after a lost reply applies nothing twice.
    // Several sends of one gesture, as a slider drag makes, are one change set: its Undo
    // goes back to the value from before the gesture.
    setTrait: request => commitField(request, traitField(request.trait), request.value),
    setFavorite: request => commitField(request, FAVORITE_FIELD, request.value),
    // Copies hand-set traits and favourites as user decisions made at decidedAt. Replaying it
    // changes nothing: a decision older than the stored one is ignored. Albums with no anchor
    // yet are returned as pending, to be migrated after a later scan.
    async migrate({ decidedAt, albums }) {
      const migrated = [], pending = []
      for (const { providerAlbumId, favorite, traits = {} } of albums) {
        const decisions = Object.entries(traits).map(([trait, value]) => ({ kind: 'trait', trait, value, decidedAt }))
        if (favorite !== undefined) decisions.push({ kind: 'favorite', value: favorite, decidedAt })
        const { applied } = await decide(providerAlbumId, decisions)
        ;(applied ? migrated : pending).push(providerAlbumId)
      }
      return { migrated, pending }
    },
    // Receipts of what changed, newest first.
    async activity({ offset = 0, limit = ACTIVITY_PAGE } = {}) {
      const { changeSets, total } = await service.listChangeSets({ offset, limit })
      const titles = new Map()
      const subjects = changeSets.flatMap(changeSet => changeSet.operations.map(item => item.operation))
        .flatMap(operation => [operation.subject, ...[operation.into, operation.albumId].filter(Boolean).map(id => ({ kind: 'album', id }))]).filter(subject => subject?.kind === 'album')
      for (const { id } of subjects) if (!titles.has(id)) titles.set(id, (await service.getCatalogAlbum({ albumId: id })).album?.title)
      const nameOf = subject => (subject.kind === 'album' ? titles.get(subject.id) ?? 'an album' : 'a track')
      const entries = changeSets.map(changeSet => {
        const [first, ...others] = changeSet.operations
        const described = describeOperation(first.operation, nameOf)
        const undone = UNDONE_STATES.includes(changeSet.state)
        const blocked = !undone && changeSet.dependents.length > 0
        const { author } = changeSet
        return {
          id: changeSet.id, at: changeSet.committedAt, actor: author.kind === 'user' ? 'you' : 'kept',
          // The route that proposed it, also when a job ran the route.
          route: author.kind === 'user' ? undefined : author.route ?? author.id,
          summary: changeSet.summary ?? (others.length ? `${described.summary} and ${others.length} more` : described.summary),
          detail: blocked ? BLOCKED_DETAIL : changeSet.state === 'suppressed' ? SUPPRESSED_DETAIL : described.detail, undone, undoable: !undone && !blocked,
          operations: changeSet.operations.map((item, index) => ({ index, ...compareOperation(item, nameOf), undone: item.state === 'undone' })),
        }
      })
      return { entries, total }
    },
    // Undoes one change set as the user, or the chosen operations of it. Dependents are reported, not taken along.
    async undo({ id, operations }) {
      const result = await service.undoChangeSet({ id, operations, undoneAt: now() })
      return result.status === 'undone' ? { status: 'undone' } : { status: 'blocked', reason: result.reason, blockedBy: result.blockedBy }
    },
    // Traits computed from the sound of each analysed album, by anchor ID. A view for display and Dig, not a decision.
    estimatedTraits: async () => ({ albums: estimates ? await estimates.estimate() : {} }),
    similarAlbums: async ({ albumId }) => soundSimilarity?.(albumId) ?? { analysed: false, albumIds: [] },
    // Runs a deterministic tool with no LLM involved. Only IDs and scores come back.
    tool: async ({ name, input }) => {
      if (!tools) throw new Error('Tools are not available')
      return tools.run(name, input)
    },
    consent: () => service.getConsent(),
    setConsent: ({ consent, value }) => service.setConsent({ consent, value, decidedAt: now() }),
  }
}

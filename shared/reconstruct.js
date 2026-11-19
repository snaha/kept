// The reconstruction ladder (plan phase A4). One album-sized cluster goes through the routes in
// order of cost, and the ladder stops as soon as nothing is left to repair. Every route that ran
// leaves an outcome, and every repair is a proposal with the evidence it rests on. Nothing here
// reads a file, opens a socket or writes the catalog: the caller hands in tools, and commits the
// proposals through the ledger. Types: reconstruct.d.ts.
import {
  ASSIGNMENT_POLICY, MIN_MATCHED, NAME_SIMILARITY, RELEASE_POLICY, chooseRelease, cleanTitle, discOfFolder, discOfTitle, evaluateRelease, isVarious, known, norm,
  parseFileName, primaryCredit, sameArtist, similarity, squash,
} from './reconstruct-match.js'

export const LOCAL_POLICY = 'local-grouping/1'
export const LADDER_POLICY = `ladder/1 ${LOCAL_POLICY} ${ASSIGNMENT_POLICY} ${RELEASE_POLICY}`
export const MUSICBRAINZ_SOURCE_ID = 'musicbrainz'
export const ACOUSTID_SOURCE_ID = 'acoustid'
// Registry entries of the online sources. MusicBrainz core data is CC0. Its tags and genres are
// CC BY-NC-SA and are never asked for or stored. AcoustID is for non-commercial use.
export const MUSICBRAINZ_SOURCE = Object.freeze({
  id: MUSICBRAINZ_SOURCE_ID, kind: 'musicbrainz', label: 'MusicBrainz', evidenceClass: 'deterministic', licence: 'CC0-1.0',
  policy: Object.freeze({ analysisAllowed: false, network: 'internet', consent: 'online-lookups' }),
})
export const ACOUSTID_SOURCE = Object.freeze({
  id: ACOUSTID_SOURCE_ID, kind: 'acoustid', label: 'AcoustID', evidenceClass: 'deterministic', licence: 'non-commercial',
  policy: Object.freeze({ analysisAllowed: false, network: 'internet', consent: 'acoustid' }),
})
// The routes, cheapest first. `source` is the registered source a route needs permission for.
export const ROUTES = Object.freeze([
  { stage: 0, id: 'decisions' },
  { stage: 1, id: 'local-tags' },
  { stage: 2, id: 'folder-structure' },
  { stage: 3, id: 'provider-cache', source: MUSICBRAINZ_SOURCE_ID },
  { stage: 4, id: 'musicbrainz-ids', source: MUSICBRAINZ_SOURCE_ID },
  { stage: 5, id: 'musicbrainz-search', source: MUSICBRAINZ_SOURCE_ID },
  { stage: 6, id: 'acoustid', source: ACOUSTID_SOURCE_ID },
].map(Object.freeze))
export const ROUTE_STATUSES = Object.freeze(['succeeded', 'no-match', 'ambiguous', 'not-applicable', 'unavailable', 'deferred', 'retryable-failure', 'not-permitted-by-user'])
// What can be wrong with an album. 'edition' is asked only of the online routes.
export const NEEDS = Object.freeze(['grouping', 'title', 'artist', 'numbering', 'track-titles', 'edition'])
export const VARIOUS_ARTISTS = 'Various Artists'
// Field names of the MusicBrainz observations kept on an album.
export const RELEASE_GROUP_FIELD = 'musicbrainz.release-group'
export const RELEASE_FIELD = 'musicbrainz.release'

// A compilation told by its tags alone: this many acts, none holding more than this share.
const MIN_COMPILATION_ARTISTS = 4
const MAX_COMPILATION_SHARE = 0.5
// An embedded release ID speaks for an album when at least this share of its tracks carry it.
const MIN_EMBEDDED_SHARE = 0.5
const MAX_EVIDENCE = 20
const MAX_SUMMARY = 200
// File-name numbers are believed only up to this one: '311 - Down' starts with a band, not a position.
const MAX_FILE_TRACK = 99
const MAX_RELEASE_CANDIDATES = 5
const MAX_RECORDING_PROBES = 2
const MIN_RECORDING_VOTES = 2
const FIRST_DISC = 1
const YEAR_LENGTH = 4
const FOLDER_ALBUM = /^(.+?)\s+[-–]\s+(.+)$/
const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193
const FNV_SECOND_SEED = 0x9747b28c
const HEX = 16
const HASH_WIDTH = 8

const fnv = (text, seed) => {
  let hash = seed
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), FNV_PRIME)
  return (hash >>> 0).toString(HEX).padStart(HASH_WIDTH, '0')
}
// A short stable name for a piece of JSON. Not a secret: it only tells two inputs apart.
export const digest = value => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return fnv(text, FNV_OFFSET) + fnv(text, FNV_SECOND_SEED)
}
const dirOf = path => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const baseOf = path => path.slice(path.lastIndexOf('/') + 1)
const unique = values => [...new Set(values)]
const album = id => ({ kind: 'album', id })
const asset = id => ({ kind: 'asset', id })
const numberKey = track => `${track.disc ?? FIRST_DISC}:${track.number}`
const collides = keys => new Set(keys).size !== keys.length

// The cluster as the ladder works on it: merges the earlier routes proposed are already applied
// here, so a later route sees the album the catalog will hold.
function openState(cluster, embedded) {
  const tracks = cluster.tracks.map(track => {
    const name = parseFileName(baseOf(track.path))
    return { ...track, dir: `${track.sourceId}/${dirOf(track.path)}`, folder: baseOf(dirOf(track.path)), fileTrack: name.track, stem: name.stem, embedded: embedded.get(track.assetId) ?? {} }
  })
  const albums = new Map(cluster.albums.map(item => [item.id, { ...item, locks: item.locks ?? [], userFields: item.userFields ?? [] }]))
  const state = { seed: cluster.seed, albums, tracks, needs: new Set(), changeSets: [], observations: [], facts: new Map() }
  state.of = id => state.tracks.filter(track => track.albumId === id)
  state.live = () => [...albums.values()].filter(item => state.of(item.id).length > 0)
  state.dirs = id => unique(state.of(id).map(track => track.dir))
  state.locked = (id, field) => albums.get(id).locks.includes(field)
  // The user's own value of a field is never proposed over.
  state.free = (id, field) => !state.locked(id, field) && !albums.get(id).userFields.includes(field)
  return state
}

// The anchor a merge keeps: the one with the most tracks, then the oldest. The same whichever
// member of the group the job was started for.
const survivorOf = (state, ids) => [...ids].sort((a, b) => state.of(b).length - state.of(a).length || state.albums.get(a).seq - state.albums.get(b).seq)[0]

function evidenceOf(state, ids) {
  const references = []
  for (const id of ids) {
    const item = state.albums.get(id)
    if (item.evidence?.title) references.push({ observationId: item.evidence.title })
    if (item.evidence?.artist) references.push({ observationId: item.evidence.artist })
  }
  for (const sourceId of unique(ids.flatMap(id => state.of(id).map(track => track.sourceId)))) references.push({ sourceId })
  return references.slice(0, MAX_EVIDENCE)
}

function propose(state, route, { operations, evidence, summary, dependsOn = [] }) {
  if (!operations.length) return undefined
  const key = `${route}:${state.changeSets.length}`
  state.changeSets.push({ key, route, operations, evidence, dependsOn, summary })
  return key
}

// Applies a merge to the working state and returns its operations. Tracks keep their numbers.
function merge(state, ids, { discs, title, artist } = {}) {
  const into = survivorOf(state, ids)
  const from = ids.filter(id => id !== into)
  const operations = [{ kind: 'merge-albums', into, from }]
  for (const track of state.tracks) {
    if (!ids.includes(track.albumId)) continue
    const disc = discs?.get(track.albumId)
    if (disc !== undefined && disc !== track.disc) {
      operations.push({ kind: 'move-track', assetId: track.assetId, albumId: into, disc })
      track.disc = disc
    }
    track.albumId = into
  }
  const target = state.albums.get(into)
  if (title !== undefined && title !== target.title && state.free(into, 'title')) {
    operations.push({ kind: 'set-field', subject: album(into), field: 'title', value: title })
    target.title = title
  }
  if (artist !== undefined && artist !== target.artist && state.free(into, 'artist')) {
    operations.push({ kind: 'set-field', subject: album(into), field: 'artist', value: artist })
    target.artist = artist
  }
  if (from.includes(state.seed)) state.seed = into
  return operations
}

const mergeable = (state, ids) => ids.every(id => !state.locked(id, 'tracks'))
const singleDir = (state, id) => state.dirs(id).length === 1
// The number a track goes by: its tag, else the one its file name starts with.
const effectiveNumbers = (state, ids) => state.tracks.filter(track => ids.includes(track.albumId)).map(track => ({ disc: track.disc, number: track.track ?? track.fileTrack }))
const numbersCollide = (state, ids) => collides(effectiveNumbers(state, ids).filter(track => track.number !== undefined).map(numberKey))

// What is wrong with the seed album as it stands. An unknown edition is asked of the online routes only.
function assess(state) {
  const seed = state.albums.get(state.seed), tracks = state.of(state.seed)
  const needs = new Set([...state.needs].filter(need => need === 'grouping'))
  // A file or two without an album tag are loose tracks, not an album that lost its name.
  if (!known(seed.title) && tracks.length >= MIN_MATCHED) needs.add('title')
  if (!known(seed.artist)) needs.add('artist')
  if (tracks.some(track => !known(track.title) || cleanTitle(track.title) !== undefined)) needs.add('track-titles')
  if (tracks.length > 1 && (tracks.some(track => track.track === undefined) || collides(tracks.map(track => numberKey({ disc: track.disc, number: track.track }))))) needs.add('numbering')
  if (state.facts.get('numbering-contradicted')) needs.add('numbering')
  if (!seed.links?.some(link => link.sourceId === MUSICBRAINZ_SOURCE_ID) && !state.facts.get('identified')) needs.add('edition')
  state.needs = needs
  return needs
}

// Stage 1: what the tags and the embedded identifiers say.
function localTags(state) {
  const route = 'local-tags'
  const notes = []
  let acted = false, open = false
  const seed = () => state.albums.get(state.seed)

  // Files that carry one MusicBrainz release ID are one album, wherever the tags filed them.
  const releaseOf = id => {
    const ids = unique(state.of(id).map(track => track.embedded.releaseId))
    return ids.length === 1 ? ids[0] : undefined
  }
  const seedRelease = releaseOf(state.seed)
  if (seedRelease !== undefined) {
    const group = state.live().filter(item => releaseOf(item.id) === seedRelease).map(item => item.id)
    if (group.length > 1 && mergeable(state, group)) {
      acted = Boolean(propose(state, route, { operations: merge(state, group), evidence: evidenceOf(state, group), summary: 'Joined albums whose files name one release' }))
      notes.push('embedded-release')
    }
  }

  // The same album title in the same folder, split because the artist is spelled two ways or
  // because every track has its own artist.
  if (known(seed().title) && singleDir(state, state.seed)) {
    const [dir] = state.dirs(state.seed)
    const title = norm(seed().title)
    const group = state.live().filter(item => singleDir(state, item.id) && state.dirs(item.id)[0] === dir && known(item.title) && norm(item.title) === title).map(item => item.id)
    if (group.length > 1) {
      const tracks = state.tracks.filter(track => group.includes(track.albumId))
      const alike = group.every(id => sameArtist(state.albums.get(id).artist, seed().artist))
      const collision = numbersCollide(state, group)
      const flagged = tracks.every(track => track.embedded.compilation === true || isVarious(track.embedded.albumArtist))
      const acts = new Map()
      for (const track of tracks) acts.set(squash(primaryCredit(track.artist)), (acts.get(squash(primaryCredit(track.artist))) ?? 0) + 1)
      const wholeFolder = state.tracks.filter(track => track.dir === dir).every(track => group.includes(track.albumId))
      const various = acts.size >= MIN_COMPILATION_ARTISTS && Math.max(...acts.values()) / tracks.length <= MAX_COMPILATION_SHARE && wholeFolder
      if (!mergeable(state, group)) notes.push('membership-locked')
      else if (alike && !collision) {
        acted = Boolean(propose(state, route, { operations: merge(state, group), evidence: evidenceOf(state, group), summary: 'Joined one album whose artist was spelled in several ways' })) || acted
        notes.push('same-artist')
      } else if (!alike && !collision && (flagged || various)) {
        acted = Boolean(propose(state, route, { operations: merge(state, group, { artist: VARIOUS_ARTISTS }), evidence: evidenceOf(state, group), summary: 'Joined the tracks of a compilation' })) || acted
        notes.push('compilation')
      } else {
        open = true
        notes.push(collision ? 'track-numbers-collide' : 'artists-differ')
      }
    }
  }

  // A title that ends in a file extension was written by a careless tagger.
  const operations = []
  for (const track of state.of(state.seed)) {
    const title = cleanTitle(track.title)
    if (title === undefined || track.userFields?.includes('title') || track.locks?.includes('title')) continue
    operations.push({ kind: 'set-field', subject: asset(track.assetId), field: 'title', value: title })
    track.title = title
  }
  if (operations.length) {
    const references = state.of(state.seed).flatMap(track => (track.evidence?.title ? [{ observationId: track.evidence.title }] : [])).slice(0, MAX_EVIDENCE)
    acted = Boolean(propose(state, route, { operations, evidence: references.length ? references : evidenceOf(state, [state.seed]), summary: 'Removed file extensions from track titles' })) || acted
    notes.push('title-extension')
  }
  if (open) state.needs.add('grouping')
  else if (acted) state.needs.delete('grouping')
  return { status: acted ? 'succeeded' : open ? 'ambiguous' : 'not-applicable', detail: notes.join(' ') || undefined }
}

// Stage 2: what the folders and the file names say.
function folderStructure(state) {
  const route = 'folder-structure'
  const notes = []
  let acted = false, open = false, contradicted = false
  const seed = () => state.albums.get(state.seed)

  // The discs of one set: a disc number in the album title or in the folder name.
  const discOf = id => {
    if (!singleDir(state, id)) return undefined
    const item = state.albums.get(id), [dir] = state.dirs(id)
    const titled = discOfTitle(item.title), folder = discOfFolder(baseOf(dir))
    const disc = titled?.disc ?? folder
    // A disc folder sits beside its siblings. A disc named only in the title shares their folder.
    return disc === undefined ? undefined : { disc, title: titled?.title ?? item.title, parent: folder === undefined ? dir : dirOf(dir), suffix: Boolean(titled) }
  }
  const mine = discOf(state.seed)
  if (mine && known(mine.title)) {
    const group = state.live().filter(item => {
      const other = discOf(item.id)
      return other && known(other.title) && norm(other.title) === norm(mine.title) && other.parent === mine.parent && sameArtist(item.artist, seed().artist)
    }).map(item => item.id)
    const discs = new Map(group.map(id => [id, discOf(id).disc]))
    if (group.length > 1) {
      if (new Set(discs.values()).size === group.length && mergeable(state, group)) {
        acted = Boolean(propose(state, route, { operations: merge(state, group, { discs, title: mine.suffix ? mine.title : undefined }), evidence: evidenceOf(state, group), summary: 'Joined the discs of one album' }))
        notes.push('discs')
      } else {
        open = true
        notes.push('disc-numbers-repeat')
      }
    }
  }

  // One album whose files sit in disc folders but carry no disc number.
  const spread = state.dirs(state.seed)
  const folderDiscs = spread.map(dir => discOfFolder(baseOf(dir)))
  const oneSet = spread.length > 1 && folderDiscs.every(disc => disc !== undefined) && new Set(folderDiscs).size === spread.length && new Set(spread.map(dirOf)).size === 1
  if (oneSet && state.of(state.seed).every(track => track.disc === undefined || track.disc === FIRST_DISC) && !state.locked(state.seed, 'tracks')) {
    const operations = []
    for (const track of state.of(state.seed)) {
      const disc = folderDiscs[spread.indexOf(track.dir)]
      if (disc === track.disc) continue
      operations.push({ kind: 'move-track', assetId: track.assetId, albumId: state.seed, disc })
      track.disc = disc
    }
    acted = Boolean(propose(state, route, { operations, evidence: evidenceOf(state, [state.seed]), summary: 'Numbered the discs of an album by its folders' })) || acted
    notes.push('disc-folders')
  }

  // Tracks left without an album tag, next to the one album of their artist in the same folder.
  if (singleDir(state, state.seed) && known(seed().artist)) {
    const [dir] = state.dirs(state.seed)
    const here = state.live().filter(item => singleDir(state, item.id) && state.dirs(item.id)[0] === dir && sameArtist(item.artist, seed().artist))
    const titled = here.filter(item => known(item.title)), untitled = here.filter(item => !known(item.title))
    if (titled.length === 1 && untitled.length >= 1 && here.some(item => item.id === state.seed)) {
      const group = here.map(item => item.id)
      const numbers = effectiveNumbers(state, group)
      if (numbers.every(track => track.number !== undefined) && !numbersCollide(state, group) && mergeable(state, group)) {
        acted = Boolean(propose(state, route, { operations: merge(state, group, { title: titled[0].title }), evidence: evidenceOf(state, group), summary: 'Returned tracks without an album tag to their album' })) || acted
        notes.push('untitled-remainder')
      } else {
        open = true
        notes.push('remainder-unnumbered')
      }
    }
  }

  // An album without a title in a folder named 'Artist - Album'.
  if (!known(seed().title) && singleDir(state, state.seed) && state.free(state.seed, 'title')) {
    const [dir] = state.dirs(state.seed)
    const match = FOLDER_ALBUM.exec(baseOf(dir).replace(/_/g, ' '))
    const alone = state.tracks.filter(track => track.dir === dir).every(track => track.albumId === state.seed)
    if (match && alone && known(match[2]) && sameArtist(match[1], seed().artist)) {
      acted = Boolean(propose(state, route, {
        operations: [{ kind: 'set-field', subject: album(state.seed), field: 'title', value: match[2].trim() }], evidence: evidenceOf(state, [state.seed]), summary: 'Named an album after its folder',
      })) || acted
      seed().title = match[2].trim()
      notes.push('folder-title')
    }
  }

  // Track numbers from the file names, when the tags have none or repeat one.
  const tracks = state.of(state.seed)
  const tagKeys = tracks.map(track => numberKey({ disc: track.disc, number: track.track }))
  const fileKeys = tracks.map(track => numberKey({ disc: track.disc, number: track.fileTrack }))
  const filesComplete = tracks.length > 1 && tracks.every(track => track.fileTrack > 0 && track.fileTrack <= MAX_FILE_TRACK) && !collides(fileKeys)
  const tagsDefective = tracks.some(track => track.track === undefined) || collides(tagKeys)
  if (filesComplete && tagsDefective && !state.locked(state.seed, 'tracks')) {
    const operations = tracks.filter(track => track.track !== track.fileTrack).map(track => ({ kind: 'move-track', assetId: track.assetId, albumId: state.seed, track: track.fileTrack }))
    for (const track of tracks) track.track = track.fileTrack
    acted = Boolean(propose(state, route, { operations, evidence: evidenceOf(state, [state.seed]), summary: 'Numbered tracks by their file names' })) || acted
    notes.push('file-numbers')
  } else if (filesComplete && tracks.some(track => track.track !== track.fileTrack)) {
    // The tags and the file names both number the album, differently: neither is taken.
    state.facts.set('numbering-contradicted', true)
    contradicted = true
    notes.push('numbers-contradict')
  }

  // A track without a title in a file named 'Artist - Title'.
  const titles = []
  for (const track of tracks) {
    if (known(track.title) || track.userFields?.includes('title')) continue
    const parts = track.stem.split(/\s+[-–]\s+/)
    const title = parts.length > 1 && known(track.artist) && sameArtist(parts[0], track.artist) ? parts.slice(1).join(' - ') : undefined
    if (!known(title)) continue
    titles.push({ kind: 'set-field', subject: asset(track.assetId), field: 'title', value: title })
    track.title = title
  }
  if (titles.length) {
    acted = Boolean(propose(state, route, { operations: titles, evidence: evidenceOf(state, [state.seed]), summary: 'Titled tracks by their file names' })) || acted
    notes.push('file-titles')
  }
  if (open) state.needs.add('grouping')
  return { status: acted ? 'succeeded' : open || contradicted ? 'ambiguous' : 'not-applicable', detail: notes.join(' ') || undefined }
}

const localsOf = tracks => tracks.map(track => ({ id: track.assetId, title: track.title, duration: track.duration, track: track.track, disc: track.disc, recordingId: track.embedded.recordingId }))
const yearOf = date => (typeof date === 'string' && Number(date.slice(0, YEAR_LENGTH)) > 0 ? Number(date.slice(0, YEAR_LENGTH)) : undefined)

// Turns an accepted release into proposals: the observation it rests on, the albums it joins and
// the fields every indistinguishable edition agrees on. The edition itself is linked only when an
// identifier names it.
function publish(state, route, choice, { edition }) {
  const { best, editions } = choice
  const { release } = best
  const slotOf = new Map(best.assignment.pairs.filter(pair => !pair.ambiguous).map(pair => [pair.id, best.slots[pair.slot]]))
  // A position counts only when every edition that fits as well puts the track there.
  const agreed = assetId => editions.every(other => {
    const pair = other.assignment.pairs.find(item => item.id === assetId && !item.ambiguous)
    const slot = pair && other.slots[pair.slot], mine = slotOf.get(assetId)
    return slot && slot.disc === mine.disc && slot.position === mine.position
  })
  const matchedAlbums = unique(state.tracks.filter(track => slotOf.has(track.assetId)).map(track => track.albumId))
  const whole = matchedAlbums.filter(id => state.of(id).every(track => slotOf.has(track.assetId)))
  const group = unique([state.seed, ...whole])
  const observationKey = `${route}:observation:${state.observations.length}`
  const year = yearOf(release.firstReleaseDate) ?? yearOf(release.date)
  const observation = {
    key: observationKey, sourceId: MUSICBRAINZ_SOURCE_ID, field: edition ? RELEASE_FIELD : RELEASE_GROUP_FIELD,
    value: edition
      ? { id: release.id, releaseGroupId: release.releaseGroupId ?? '', title: release.title, artist: release.artist, date: release.date ?? '', tracks: best.slots.length }
      : { id: release.releaseGroupId ?? release.id, title: release.title, artist: release.artist, year: year ?? 0, editions: editions.map(item => item.release.id).sort() },
  }
  const evidence = [{ observation: observationKey }]
  const dependsOn = []
  if (group.length > 1 && mergeable(state, group)) {
    const key = propose(state, route, { operations: merge(state, group), evidence, summary: `Joined the albums that make up ${release.title}`.slice(0, MAX_SUMMARY) })
    if (key) dependsOn.push(key)
  }
  const target = state.albums.get(state.seed)
  observation.subject = album(state.seed)
  state.observations.push(observation)
  const operations = []
  const setAlbum = (field, value, replace) => {
    if (value === undefined || !state.free(state.seed, field) || target[field] === value || !replace) return
    operations.push({ kind: 'set-field', subject: album(state.seed), field, value })
    target[field] = value
  }
  // A missing title is filled in and a near miss is corrected. A different title stays as tagged.
  setAlbum('title', release.title, !known(target.title) || (norm(target.title) !== norm(release.title) && similarity(target.title, release.title) >= NAME_SIMILARITY))
  setAlbum('artist', release.artist, !known(target.artist))
  setAlbum('year', year, target.year === undefined)
  const renumber = state.needs.has('numbering') && !state.locked(state.seed, 'tracks')
  for (const track of state.of(state.seed)) {
    const slot = slotOf.get(track.assetId)
    if (!slot) continue
    if (!known(track.title) && !track.userFields?.includes('title')) {
      operations.push({ kind: 'set-field', subject: asset(track.assetId), field: 'title', value: slot.title })
      track.title = slot.title
    }
    const moved = track.track !== slot.position || (track.disc ?? FIRST_DISC) !== slot.disc
    if (moved && agreed(track.assetId) && (renumber || track.track === undefined)) {
      operations.push({ kind: 'move-track', assetId: track.assetId, albumId: state.seed, disc: slot.disc, track: slot.position })
      track.track = slot.position
      track.disc = slot.disc
    }
  }
  if (edition && !state.locked(state.seed, 'links')) {
    operations.push({ kind: 'relink-provider', sourceId: MUSICBRAINZ_SOURCE_ID, linkKind: 'album', externalId: release.id, subject: album(state.seed) })
  }
  propose(state, route, { operations, evidence, dependsOn, summary: `${edition ? 'Identified' : 'Repaired'} ${release.title} from MusicBrainz`.slice(0, MAX_SUMMARY) })
  state.facts.set('identified', true)
  if (renumber) state.facts.delete('numbering-contradicted')
  state.needs.delete('grouping')
}
// The album the online routes try to identify: the seed's tracks must be covered, and the other
// tracks of the cluster may join when the release holds them too.
const targetOf = (state, withOthers) => {
  const seed = state.albums.get(state.seed), own = state.of(state.seed)
  // A neighbour whose tags name another album keeps it: being on the release too is no reason to move it.
  const joins = id => {
    const other = state.albums.get(id)
    return !state.locked(id, 'tracks') && (!known(other.title) || norm(discOfTitle(other.title)?.title ?? other.title) === norm(discOfTitle(seed.title)?.title ?? seed.title))
  }
  const others = withOthers ? state.tracks.filter(track => track.albumId !== state.seed && joins(track.albumId)) : []
  return { title: seed.title, artist: seed.artist, own, others }
}
// Coverage is judged on the seed's own tracks: the others only ride along.
function evaluate(state, release) {
  const target = targetOf(state, true)
  const core = evaluateRelease({ title: target.title, artist: target.artist, tracks: localsOf(target.own) }, release)
  if (!core.accepted || !target.others.length) return core
  const wide = evaluateRelease({ title: target.title, artist: target.artist, tracks: localsOf([...target.own, ...target.others]) }, release)
  const firm = new Set(wide.assignment.pairs.filter(pair => !pair.ambiguous).map(pair => pair.id))
  // Taking the neighbours along must not cost the seed a track.
  const kept = core.assignment.pairs.filter(pair => !pair.ambiguous).every(pair => firm.has(pair.id))
  return kept ? { ...core, assignment: wide.assignment, slots: wide.slots } : core
}

const embeddedRelease = state => {
  const tracks = state.of(state.seed)
  const ids = unique(tracks.map(track => track.embedded.releaseId).filter(id => id !== undefined))
  const share = tracks.filter(track => track.embedded.releaseId !== undefined).length / tracks.length
  return { ids, usable: ids.length === 1 && share >= MIN_EMBEDDED_SHARE }
}

// Stage 4, and the identifier half of stage 3: the release the files themselves name.
async function byIdentifier(state, route, provider) {
  const { ids, usable } = embeddedRelease(state)
  if (!ids.length) return { status: 'not-applicable', detail: 'no-embedded-release' }
  if (!usable) return { status: 'ambiguous', detail: 'embedded-releases-disagree' }
  const release = await provider.release(ids[0])
  if (!release) return { status: 'no-match', detail: 'unknown-release' }
  const evaluation = evaluate(state, release)
  // The identifier chose the release, so the title may differ. The tracks still have to be on it.
  const vetoes = evaluation.vetoes.filter(veto => veto !== 'title' && veto !== 'artist' && veto !== 'completeness')
  if (vetoes.length) return { status: 'ambiguous', detail: `embedded-release-contradicted ${vetoes.join(' ')}` }
  publish(state, route, { best: evaluation, editions: [evaluation] }, { edition: true })
  return { status: 'succeeded', detail: `release ${release.id}` }
}

// Stage 5, and the search half of stage 3: a structured search, then the tracklists compared.
async function bySearch(state, route, provider) {
  const target = targetOf(state, false)
  const ids = []
  const add = found => { for (const id of found) if (!ids.includes(id)) ids.push(id) }
  if (known(target.title)) {
    const title = discOfTitle(target.title)?.title ?? target.title
    add(await provider.searchReleases({ title, artist: known(target.artist) && !isVarious(target.artist) ? target.artist : undefined }))
  }
  if (!ids.length) {
    // No usable album title: ask which releases hold two of its tracks, and keep those that hold both.
    const probes = target.own.filter(track => known(track.title) && known(track.artist)).sort((a, b) => b.title.length - a.title.length || (a.assetId < b.assetId ? -1 : 1)).slice(0, MAX_RECORDING_PROBES)
    const votes = new Map()
    for (const track of probes) for (const id of unique(await provider.searchRecordings({ title: track.title, artist: track.artist }))) votes.set(id, (votes.get(id) ?? 0) + 1)
    const needed = Math.min(MIN_RECORDING_VOTES, probes.length)
    add([...votes].filter(([, count]) => count >= needed).map(([id]) => id))
  }
  if (!ids.length) return { status: 'no-match', detail: 'nothing-found' }
  const evaluations = []
  for (const id of ids.slice(0, MAX_RELEASE_CANDIDATES)) {
    const release = await provider.release(id)
    if (release) evaluations.push(evaluate(state, release))
  }
  const choice = chooseRelease(evaluations)
  if (choice.status === 'ambiguous') return { status: 'ambiguous', detail: `releases ${choice.releases.join(' ')}` }
  if (choice.status === 'no-match') {
    const vetoes = unique(evaluations.flatMap(evaluation => evaluation.vetoes)).sort()
    return { status: 'no-match', detail: `candidates ${evaluations.length}${vetoes.length ? ` ${vetoes.join(' ')}` : ''}` }
  }
  publish(state, route, choice, { edition: false })
  return { status: 'succeeded', detail: `release-group ${choice.best.release.releaseGroupId ?? choice.best.release.id} editions ${choice.editions.length}` }
}

// How a tool failure is recorded. A miss in the cache-only stage is simply no cached answer.
const failureOf = error => {
  if (error?.code === 'cache-miss') return { status: 'no-match', detail: 'not-cached' }
  if (error?.code === 'budget') return { status: 'deferred', detail: 'request-budget', retry: 'later' }
  return { status: 'retryable-failure', detail: String(error?.message ?? error).slice(0, MAX_SUMMARY), retry: 'later' }
}

export function clusterInputHash(cluster, embedded) {
  return digest({
    policy: LADDER_POLICY, seed: cluster.seed,
    albums: cluster.albums.map(item => [item.id, item.title, item.artist, item.year, item.locks, item.userFields, (item.links ?? []).map(link => `${link.sourceId}:${link.externalId}`)]),
    tracks: cluster.tracks.map(track => [track.assetId, track.albumId, track.disc, track.track, track.sourceId, track.path, track.title, track.artist, track.duration, embedded.get(track.assetId)]),
    permissions: cluster.permissions,
  })
}

// Runs the ladder over one cluster.
//   cluster      what the catalog holds: { seed, albums, tracks, permissions, previous? }
//   tools.readEmbedded(track) -> { releaseId?, recordingId?, releaseGroupId?, compilation?, albumArtist? }, optional
//   tools.provider            the MusicBrainz client; tools.cachedProvider answers from the cache only
//   tools.fingerprint         the AcoustID route, optional
//   tools.rest()              awaited between slices of work, optional
export async function runLadder(cluster, tools = {}) {
  const embedded = new Map()
  if (tools.readEmbedded) {
    for (const track of cluster.tracks) {
      await tools.rest?.()
      const tags = await tools.readEmbedded(track)
      if (tags) embedded.set(track.assetId, tags)
    }
  }
  const inputHash = clusterInputHash(cluster, embedded)
  const state = openState(cluster, embedded)
  const outcomes = []
  const permission = sourceId => cluster.permissions?.[sourceId] ?? { status: 'not-permitted-by-user', consent: sourceId === ACOUSTID_SOURCE_ID ? 'acoustid' : 'online-lookups' }
  const online = permission(MUSICBRAINZ_SOURCE_ID).status === 'permitted'
  const requests = () => tools.provider?.requests?.() ?? 0
  const record = (route, outcome, spent = 0) => outcomes.push({ route: route.id, stage: route.stage, policy: LADDER_POLICY, inputHash, requests: spent, ...outcome })
  const result = status => ({
    seed: cluster.seed, survivor: state.seed, status, online, needs: [...state.needs].sort(), inputHash, policy: LADDER_POLICY, outcomes, observations: state.observations, changeSets: state.changeSets,
    blockedBy: unique(outcomes.filter(outcome => outcome.status === 'not-permitted-by-user').map(outcome => outcome.consent)),
    retry: outcomes.some(outcome => outcome.status === 'retryable-failure' || outcome.status === 'deferred'),
  })
  if (!cluster.albums.some(item => item.id === cluster.seed) || !state.of(cluster.seed).length) return result('gone')

  const [decisions, tags, folders, cache, identifiers, search, acoustid] = ROUTES

  // Stage 0: what was already decided. An answer reached on the same input under the same policy stands.
  const earlier = cluster.previous
  const reusable = earlier?.inputHash === inputHash && earlier.policy === LADDER_POLICY && earlier.status === 'resolved' && earlier.online === online && !earlier.retry
  const locks = cluster.albums.find(item => item.id === cluster.seed).locks ?? []
  record(decisions, reusable ? { status: 'succeeded', detail: 'unchanged-since-resolved' } : { status: 'not-applicable', detail: locks.length ? `locks ${[...locks].sort().join(' ')}` : undefined })
  // The stored attempt keeps what its routes concluded, such as the consent that held them back.
  if (reusable) return { ...result('resolved'), reused: true }

  // The local routes always run: only they can tell that an album was split.
  record(tags, localTags(state))
  await tools.rest?.()
  record(folders, folderStructure(state))
  if (!assess(state).size) return result('resolved')

  // A release is accepted on at least MIN_MATCHED tracks: a loose file or two is not looked up.
  const tooSmall = state.of(state.seed).length < MIN_MATCHED
  for (const route of [cache, identifiers, search]) {
    if (!online) { record(route, permission(route.source)); continue }
    if (tooSmall) { record(route, { status: 'not-applicable', detail: 'too-few-tracks' }); continue }
    const provider = route === cache ? tools.cachedProvider : tools.provider
    if (!provider) { record(route, { status: 'unavailable', detail: 'no-provider' }); continue }
    await tools.rest?.()
    const before = requests()
    const attempt = async step => { try { return await step(state, route.id, provider) } catch (error) { return failureOf(error) } }
    let outcome = route === search ? undefined : await attempt(byIdentifier)
    if (route !== identifiers && outcome?.status !== 'succeeded') {
      const searched = await attempt(bySearch)
      // What the identifiers contradicted stays visible unless the search settled it.
      outcome = outcome?.status === 'ambiguous' && searched.status !== 'succeeded' ? outcome : searched
    }
    record(route, outcome, requests() - before)
    if (!assess(state).size) return result('resolved')
  }

  // Stage 6: fingerprints, only with the user's own key.
  const acoustidPermission = permission(ACOUSTID_SOURCE_ID)
  if (acoustidPermission.status !== 'permitted') record(acoustid, acoustidPermission)
  else if (!tools.fingerprint) record(acoustid, { status: 'unavailable', detail: 'no-key-or-fingerprinter' })
  else {
    let outcome
    try { outcome = await tools.fingerprint(state) } catch (error) { outcome = failureOf(error) }
    record(acoustid, outcome)
  }
  // An unknown edition is not a defect of the album: offline, or when no route could name it, the
  // repaired album stands as it is.
  const open = [...assess(state)].filter(need => need !== 'edition')
  return result(open.length ? 'unresolved' : 'resolved')
}

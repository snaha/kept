import { execFile } from 'node:child_process'
import { mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { hashAudioPayload } from '../audio-payload.js'
import { runLadder, digest } from '../../shared/reconstruct.js'
import { norm } from '../../shared/reconstruct-match.js'

// The answer-key corpus of the reconstruction ladder, and a stand-in for the scanner.
// buildCorpus synthesises short tones with ffmpeg into a temporary folder and tags them with
// invented names, damaged the way real collections are damaged. The key says which files belong
// together and which repairs are expected. Nothing is written outside the folder it is given.

const run = promisify(execFile)
const AUDIO = /\.(mp3|flac|m4a|ogg|opus|wav)$/i
const MB_RELEASE_TAGS = ['musicbrainz album id', 'musicbrainz_albumid']
const MB_RECORDING_TAGS = ['musicbrainz release track id', 'musicbrainz_trackid', 'musicbrainz track id']
const PROVIDER_SOURCE = { id: 'navidrome', kind: 'navidrome', label: 'Navidrome', evidenceClass: 'deterministic', licence: 'user', policy: { analysisAllowed: true, network: 'lan' } }
const MAX_ROUNDS = 6
const SYNTH_WORKERS = 8
// How the tones are made: every file gets a frequency and a length of its own, so no two payloads match.
const BASE_HERTZ = 220
const HERTZ_STEP = 7
const BASE_SECONDS = 1
const SECONDS_STEP = 0.05
const SECONDS_STEP_COUNT = 20
const UNTAGGED_EVERY = 3
const FIRST_DISC_TRACKS = 5
const ALBUM_PAGE = 500
const YEAR_LENGTH = 4
const NUMBER_WIDTH = 2
const PROBE_BUFFER = 8 * 1024 * 1024

let tones = 0
// The length of the tone a file gets, in seconds, by the order the files are placed in.
export const toneSeconds = index => BASE_SECONDS + (index % SECONDS_STEP_COUNT) * SECONDS_STEP

// One synthesised file. tags: tag -> value, where an empty value leaves the tag out.
async function synthesise(target, tone, tags) {
  mkdirSync(path.dirname(target), { recursive: true })
  const metadata = Object.entries(tags).filter(([, value]) => value !== '').flatMap(([key, value]) => ['-metadata', `${key}=${value}`])
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${tone.hertz}:duration=${tone.seconds}`, ...metadata, '-id3v2_version', '3', '-write_id3v1', '0', target])
}

// The invented acts and tracks of the cases. Nothing here is a real artist, album or recording.
export const FICTION = {
  untitled: { artist: 'Harbor Lights', album: 'Paper Lanterns', tracks: ['Salt Wind', 'Lantern Row', 'Quiet Harbor', 'Tin Roof Rain', 'Slow Tide Home', 'Copper Sky', 'Low Fog Morning', 'Last Ferry Out'] },
  spelled: { artist: 'The Glass Orchard', spellings: ['The Glass Orchard', 'TheGlassOrchard', 'The Glass Orchard feat. Ivo Brandt'], tracks: ['Apple Light.mp3', 'Windfall', 'Orchard Gate.mp3', 'Pressed Cider', 'Green Hours', 'Ladder Song.mp3', 'Frost Row'] },
  numbered: { album: 'Orchard Sessions', tracks: ['Early Frost', 'Bare Branches', 'Cellar Door', 'Long Grass', 'Last Pruning'] },
  discs: { artist: 'Mara Vale', album: 'Night Ferry', tracks: ['Boarding Call', 'Lamp Oil', 'Wet Planks', 'Midnight Crossing', 'Fog Signal', 'Far Shore', 'Harbour Bell', 'Rope and Rust', 'Morning Berth'] },
  compilation: { album: 'Neon Atlas', tracks: [['Kite Parade', 'Juno Park'], ['Static Bloom', 'The Velvet Ants'], ['Glass Arcade', 'Pip Orlov'], ['Moth Light', 'Sable Hours'], ['Tin Cathedral', 'Rook & Wren'], ['Cold Signal', 'Nell Ashdown'], ['Paper Moon Drive', 'Ox Harbour'], ['Blue Kiln', 'Teodor Marsh']] },
  partial: { artist: 'Saffron Quay', album: 'Eclectic Rooms', tracks: ['Brass Window', 'Half Light Waltz', 'Saltpan', 'Marble Heat', 'Open Hand', 'Cinder Path', 'Linen Sky', 'Turning Room', 'Seventh Floor'] },
  acts: { a: 'Mara Vale', b: 'Harbor Lights' },
  mara: ['Stone Orchard', 'Weathervane', 'Lowland Fire', 'Ninth Bridge', 'Short Candle', 'River Ledger', 'Chalk Hymn', 'Winter Quay', 'Ember Table', 'Hollow Tram'],
  harbor: ['Gull Parade', 'Sand Letters', 'North Pier', 'Cable Hum', 'Open Water', 'Brine Clock', 'Reed Boats', 'Dock Lights'],
  loose: [['Free Download One', 'Anon Uploader'], ['Track 02', 'Unknown'], ['Mix Part A', 'DJ Placeholder'], ['Sample Loop', 'Nobody Known'], ['Ringtone Cut', 'Anon Uploader'], ['Bedroom Take', 'Quiet Fox'], ['Demo Reel', 'Quiet Fox'], ['Untitled Beat', 'Nobody Known']],
  loosePage: 'www.free-tunes-example.net',
}

// The cases. Each takes tones no other case uses, so every file is an asset of its own.
// expected.groups: the files that are one album. expected.repairs: what the ladder should do,
// offline unless marked online. A group the ladder joins across the key is a false merge.
export async function buildCorpus({ directory }) {
  const groups = [], repairs = [], jobs = []
  const place = (relative, tags) => {
    const index = tones++
    const tone = { hertz: BASE_HERTZ + index * HERTZ_STEP, seconds: toneSeconds(index) }
    jobs.push(() => synthesise(path.join(directory, ...relative.split('/')), tone, tags))
    return relative
  }
  const group = (name, files) => { groups.push({ name, files }); return files }
  const clean = title => title.replace(/\.mp3$/i, '')
  const slug = (title, number) => `${String(number).padStart(NUMBER_WIDTH, '0')} ${clean(title)}.mp3`
  tones = 0

  // 1. No album tag on any track. Offline the album keeps its files and stays untitled.
  const { untitled } = FICTION
  group('missing-album', untitled.tracks.map((title, index) => place(`missing-album/${untitled.artist}/${slug(title, index + 1)}`, { title, artist: untitled.artist, track: String(index + 1) })))
  repairs.push({ case: 'missing-album', kind: 'title', online: true, value: untitled.album })

  // 2. One album, its artist spelled three ways, so the scanner files it as three albums.
  const { spelled } = FICTION
  group('inconsistent-artist', spelled.tracks.map((title, index) => place(`inconsistent-artist/${spelled.artist}/${slug(title, index + 1)}`,
    { title, artist: spelled.spellings[index % spelled.spellings.length], album: 'Orchard Songs', track: String(index + 1) })))
  repairs.push({ case: 'inconsistent-artist', kind: 'merge' }, { case: 'inconsistent-artist', kind: 'track-titles' })

  // 3. Every track tagged as number 1. The file names still count. Its own album title, or the
  // scanner would file it with case 2: the same artist and album in two folders are one album to it.
  const { numbered } = FICTION
  group('mis-numbered', numbered.tracks.map((title, index) => place(`mis-numbered/${spelled.artist}/${slug(title, index + 1)}`, { title, artist: spelled.artist, track: '1', album: numbered.album })))
  repairs.push({ case: 'mis-numbered', kind: 'numbering' })

  // 4. One album in two disc folders, each disc tagged as an album of its own.
  const { discs } = FICTION
  group('split-discs', discs.tracks.map((title, index) => {
    const disc = index < FIRST_DISC_TRACKS ? 1 : 2
    const number = (index % FIRST_DISC_TRACKS) + 1
    return place(`split-discs/${discs.artist} - ${discs.album}/CD${disc}/${slug(title, number)}`, { title, artist: discs.artist, album: `${discs.album} (Disc ${disc})`, track: String(number) })
  }))
  repairs.push({ case: 'split-discs', kind: 'merge' })

  // 5. A compilation with an album tag and no album artist, so every act is an album of its own.
  const { compilation } = FICTION
  group('compilation', compilation.tracks.map(([title, artist], index) => place(`compilation/${compilation.album}/${slug(title, index + 1)}`, { title, artist, album: compilation.album, track: String(index + 1) })))
  repairs.push({ case: 'compilation', kind: 'merge' })

  // 6. A third of an album lost its album tag. The numbers show where the tracks belong.
  const { partial } = FICTION
  group('partial-album-tag', partial.tracks.map((title, index) => place(`partial-album-tag/${partial.artist} - ${partial.album}/${slug(title, index + 1).replace(/^(\d+) /, '$1 - ')}`,
    { title, artist: partial.artist, track: String(index + 1), album: index % UNTAGGED_EVERY === 0 ? '' : partial.album })))
  repairs.push({ case: 'partial-album-tag', kind: 'merge' })

  // 7. Two albums with one title by two artists, in two folders and in one. They stay apart.
  const { a: actA, b: actB } = FICTION.acts
  const album = (folder, files, artist, title, first = 1) => files.map((name, index) => place(`${folder}/${slug(name, first + index)}`, { title: name, artist, album: title, track: String(first + index) }))
  // Three albums' worth of each: [first file, one past the last].
  const [maraA, maraB, maraC] = [[0, 4], [4, 7], [7, 10]].map(range => FICTION.mara.slice(...range))
  const [harborA, harborB, harborC] = [[0, 3], [3, 6], [6, 8]].map(range => FICTION.harbor.slice(...range))
  group('duplicate-titles-a', album(`duplicate-titles/${actA} - Greatest Hits`, maraA, actA, 'Greatest Hits'))
  group('duplicate-titles-b', album(`duplicate-titles/${actB} - Greatest Hits`, harborA, actB, 'Greatest Hits'))
  group('same-folder-a', album('same-folder', maraB, actA, 'Best Of'))
  group('same-folder-b', album('same-folder', harborB, actB, 'Best Of'))
  // The same again with numbers that do not collide: still two artists, still two albums.
  group('split-album-a', album('split-album', maraC, actA, 'Club Hits'))
  group('split-album-b', album('split-album', harborC, actB, 'Club Hits', maraC.length + 1))

  // 8. A folder of loose files with web addresses in their album tags. Nothing in it is an album.
  const loose = FICTION.loose.map(([title, artist]) => place(`dump/Mixed/${clean(title)}.mp3`, { title, artist, album: FICTION.loosePage }))

  // A few at a time.
  await Promise.all(Array.from({ length: SYNTH_WORKERS }, async () => { while (jobs.length) await jobs.pop()() }))
  return { directory, groups, repairs, loose }
}

async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', file], { maxBuffer: PROBE_BUFFER })
  const { format = {} } = JSON.parse(stdout)
  const tags = Object.fromEntries(Object.entries(format.tags ?? {}).map(([key, value]) => [key.toLowerCase(), String(value).trim()]))
  const number = value => (Number.parseInt(value, 10) > 0 ? Number.parseInt(value, 10) : undefined)
  const first = keys => keys.map(key => tags[key]).find(Boolean)
  return {
    duration: Number(format.duration) > 0 ? Number(format.duration) : undefined,
    title: tags.title || undefined, artist: tags.artist || undefined, album: tags.album || undefined, albumArtist: tags.album_artist || undefined,
    track: number(tags.track), disc: number(tags.disc), year: number((tags.date ?? '').slice(0, YEAR_LENGTH)),
    compilation: tags.compilation === '1' ? true : undefined, releaseId: first(MB_RELEASE_TAGS), recordingId: first(MB_RECORDING_TAGS),
  }
}

function walk(root, relative = '') {
  return readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).flatMap(entry => {
    if (entry.name.startsWith('.')) return []
    const child = relative ? `${relative}/${entry.name}` : entry.name
    return entry.isDirectory() ? walk(root, child) : AUDIO.test(entry.name) ? [child] : []
  })
}

// Reads a folder the way the scanner and the music server do together: a payload hash per file,
// its tags, and albums grouped by album artist (else artist) and album title, which is how
// Navidrome files a track. Read only. Returns the scan snapshot and the embedded tags by path.
export async function scanFolder({ root, sourceId, observedAt, onProgress }) {
  const files = [], embedded = new Map(), paths = walk(root)
  for (const [index, relative] of paths.entries()) {
    const file = path.join(root, ...relative.split('/'))
    let tags, hash
    try { [tags, hash] = await Promise.all([probe(file), hashAudioPayload(file)]) } catch { continue }
    const albumArtist = tags.albumArtist ?? (tags.compilation ? 'Various Artists' : tags.artist)
    files.push({
      path: relative, contentHash: hash.contentHash, size: hash.size, duration: tags.duration, disc: tags.disc, track: tags.track,
      providerTrackId: `nd-track-${digest(relative)}`, providerAlbumId: `nd-album-${digest([norm(albumArtist), norm(tags.album)])}`,
      tags: { title: tags.title, artist: tags.artist, album: tags.album, albumArtist: tags.albumArtist, year: tags.year },
    })
    embedded.set(relative, { releaseId: tags.releaseId, recordingId: tags.recordingId, compilation: tags.compilation, albumArtist: tags.albumArtist })
    onProgress?.(index + 1, paths.length)
  }
  return { snapshot: { sourceId, providerSourceId: PROVIDER_SOURCE.id, observedAt, rootAvailable: true, complete: true, files }, embedded }
}

export const folderSourceOf = id => ({ id, kind: 'local-folder', label: 'Corpus', evidenceClass: 'deterministic', licence: 'user', policy: { analysisAllowed: true, network: 'none' } })

// Ingests a scan into a CatalogStore. Returns asset ID -> relative path.
export function ingest(store, { snapshot }) {
  if (!store.findSource(PROVIDER_SOURCE.id)) store.registerSource(PROVIDER_SOURCE)
  if (!store.findSource(snapshot.sourceId)) store.registerSource(folderSourceOf(snapshot.sourceId))
  store.ingestScan(snapshot)
  return new Map(snapshot.files.map(file => [`asset:${file.contentHash}:${file.size}`, file.path]))
}

// Runs the ladder over every queued album until the queue is empty, as the job class does, but in
// this process. tools: (cluster) -> the tools of runLadder. Returns what each run stored.
export async function reconstructAll(store, { tools, now, limit }) {
  const runs = []
  let clock = now
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { albumIds } = store.reconstruct.reconstructionQueue({ limit })
    if (!albumIds.length) break
    for (const albumId of albumIds) {
      const cluster = store.reconstruct.reconstructionCluster({ albumId })
      const provided = tools(cluster)
      const result = await runLadder(cluster, provided)
      const stored = store.reconstruct.storeReconstruction({
        albumId, now: clock++, result: { ...result, version: cluster.version, albumIds: cluster.albums.map(album => album.id), cache: provided.provider?.fresh?.() ?? [] },
      })
      runs.push({ albumId, round, result, stored })
    }
    if (limit !== undefined) break
  }
  return runs
}

// The albums the catalog holds now, as lists of relative paths.
export function catalogGroups(store, pathOf) {
  const { albums } = store.listCatalogAlbums({ limit: ALBUM_PAGE })
  return albums.map(album => {
    const detail = store.getCatalogAlbum({ albumId: album.id }).album
    return { id: album.id, title: detail.title, artist: detail.artist, tracks: detail.tracks.map(track => ({ path: pathOf.get(track.assetId), disc: track.disc, track: track.track, title: track.title })) }
  })
}

// Scores the catalog against the key.
//   falseMerges   albums that hold files of two groups of the key, or a loose file with anything else
//   coverage      share of the expected groups that are one album now
//   precision     share of the albums the ladder joined that the key agrees with
export function scoreGrouping(corpus, before, after) {
  const groupOf = new Map(corpus.groups.flatMap(group => group.files.map(file => [file, group.name])))
  for (const file of corpus.loose) groupOf.set(file, `loose:${file}`)
  const initial = new Map(before.flatMap(album => album.tracks.map(track => [track.path, album.id])))
  // An album the ladder made: it holds files that the scan had filed apart.
  const joined = after.filter(album => new Set(album.tracks.map(track => initial.get(track.path))).size > 1)
  const wrong = joined.filter(album => new Set(album.tracks.map(track => groupOf.get(track.path))).size > 1)
  const whole = corpus.groups.filter(group => {
    const holders = after.filter(album => album.tracks.some(track => group.files.includes(track.path)))
    return holders.length === 1 && holders[0].tracks.length === group.files.length
  })
  const splitBefore = corpus.groups.filter(group => new Set(group.files.map(file => initial.get(file))).size > 1)
  const repaired = splitBefore.filter(group => whole.includes(group))
  return {
    albumsBefore: before.length, albumsAfter: after.length, joined: joined.length, falseMerges: wrong.map(album => album.tracks.map(track => track.path)),
    groups: corpus.groups.length, whole: whole.length, splitBefore: splitBefore.map(group => group.name), repaired: repaired.map(group => group.name),
    coverage: splitBefore.length ? repaired.length / splitBefore.length : 1, precision: joined.length ? (joined.length - wrong.length) / joined.length : 1,
  }
}

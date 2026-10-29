/** Categories: the ways a listener browses the library (album, artist, genre, decade, length, version, songs
 *  heard in several versions) and the ways a librarian triages it (tag quality, bitrate, where the rips came
 *  from), built from the inventory and the dry-run decisions. Pure, sorted and free of absolute paths and
 *  timestamps, so the same library always gives the same file and an app can join it on relative paths. */
import { basename, relative } from 'node:path'
import type { Decision } from './decisions.ts'
import type { AlbumMatch, Enrichment, Loudness, Lyrics, TrackMatch } from './enrich.ts'
import type { Folder, FolderClass, Inventory } from './inventory.ts'
import { OWNER_SHARE } from './rules.ts'
import type { FileInfo, Tags } from './tags.ts'
import { AUDIO, ext, isVarious, known, norm, trackPrefix } from './text.ts'

export const CATEGORIES_VERSION = 1

/** A folder as a listener sees it. `dj-mix` is one DJ's set with the performers in the titles; `loose` is a
 *  playlist-like folder of unrelated tracks that should not become an album named after the folder. */
export type FolderKind = FolderClass | 'dj-mix' | 'loose'
export type Version = 'original' | 'remix' | 'acoustic' | 'live' | 'radio-edit' | 'album-version' | 'instrumental' | 'megamix'
export type Length = 'short' | 'song' | 'extended' | 'mix'
export type Quality = 'good' | 'fair' | 'poor'
export type Role = 'main' | 'featured' | 'remixer' | 'dj'
export type Credit = { name: string; role: Role }

export type Track = {
  /** relative to the scanned root; the id an app joins on */
  path: string
  folder: string
  title: string
  artist: string
  credits: Credit[]
  /** the album as tagged or planned; '' for a loose track with no real album tag */
  album: string
  albumartist: string
  track?: number
  disc?: number
  year?: number
  genre: string
  duration: number
  length: Length
  version: Version
  /** primary artist and title without version: the key that joins a song's remixes and edits */
  song: string
  kbps: number
  /** set when enrich found the file on MusicBrainz, by its album's tracklist or as a recording on its own */
  identified?: 'album' | 'recording'
  recording?: string
  /** the MusicBrainz release the album fields come from, its group and its Cover Art Archive front */
  release?: string
  releaseGroup?: string
  cover?: string
  /** MusicBrainz genres, most voted first; `genre` is the first of them when there are any */
  genres?: string[]
  lyrics?: Lyrics
  loudness?: Loudness
  tagQuality: Quality
  /** how title and artist were found where the tags were not trusted as they are */
  evidence: string[]
  issues: string[]
}

export type Group = { key: string; name: string; tracks: string[] }
export type Album = Group & {
  albumartist: string
  kind: FolderKind
  folder: string
  years: number[]
  issues: string[]
  /** MusicBrainz release and its Cover Art Archive front, when enrich matched the folder */
  release?: string
  cover?: string
  /** duration-weighted integrated loudness of the album, when every track was measured */
  lufs?: number
}
export type ArtistGroup = Group & { roles: Role[]; albums: string[] }
export type FolderGroup = { path: string; kind: FolderKind; reason: string; tracks: number }

export type Categories = {
  version: number
  summary: { tracks: number; folders: number; albums: number; artists: number; seconds: number; identified: number; covers: number; lyrics: number }
  folders: FolderGroup[]
  albums: Album[]
  artists: ArtistGroup[]
  genres: Group[]
  decades: Group[]
  lengths: Group[]
  versions: Group[]
  /** songs present more than once: a remix next to the original, the same track in two folders */
  songs: Group[]
  tagQuality: Group[]
  bitrates: Group[]
  /** the site or uploader a rip names in its comments and watermarks; one source tends to share one set of quirks */
  sources: Group[]
  /** how enrich found each file: album match, recording match or not identified */
  identified: Group[]
  lyrics: Group[]
  loudness: Group[]
  tracks: Track[]
}

/** Seconds: under SHORT is an interlude or skit, past EXTENDED an extended version, past MIX a mix or a set. */
export const SHORT = 90
export const EXTENDED = 420
export const MIX = 720
/** ID3v1 holds 30 characters a field; a value this close to it that the filename continues was cut off. */
const ID3V1_FIELD = 30
const ID3V1_SLACK = 2
/** Distinct real album tags in one folder from which the folder is loose tracks rather than one album. */
const LOOSE_ALBUMS = 3
const DECADE = 10
const KBPS = 1000

/** Folder names that say "a pile of tracks", not an album: generic words and genre names. */
const GENERIC = new Set([
  'mixed', 'mix', 'misc', 'various', 'singles', 'unsorted', 'new', 'downloads', 'mp3', 'mp3s', 'music', 'other', 'favorites',
  'trance', 'house', 'techno', 'dance', 'rock', 'pop', 'rap', 'hip hop', 'electronic', 'jazz', 'blues', 'reggae', 'punk',
])
/** MusicBrainz writes typographic quotes and hyphens ('Don’t Stop', 'Jean‐Luc'); tags and filenames
 *  are typed with ASCII ones, as Picard's "convert punctuation" option does. Dashes between words stay. */
export const ascii = (s: string): string => s.replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2010\u2011]/g, '-')

/** Genre words written in capitals ('r&b' -> 'R&B', 'uk garage' -> 'UK Garage'). */
const GENRE_ACRONYMS = new Set(['edm', 'idm', 'ebm', 'uk', 'us', 'dj', 'r&b', 'rnb', 'mpb', 'nyhc'])
/** 'big beat' -> 'Big Beat': MusicBrainz genres are lower case, tags and the app are not. */
const titleCase = (s: string): string =>
  s
    .split(' ')
    .map((w) => (GENRE_ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.replace(/(^|-)(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase())))
    .join(' ')
const JUNK_GENRES = new Set(['', 'genre', 'default', 'other', 'misc', 'unknown', 'none'])
/** Album tags that are an uploader's site or a bare number, not an album. */
const JUNK_ALBUM = /https?:|www\.|\.(com|net|org|to|am)\b|\bmp3s?\b|^\d+$/i
/** A parenthesised site or handle a ripper appended to the artist: 'The Lanterns (tunes4free.com)'. */
const WATERMARK = /\s*\([^)]*(https?:|www\.|\.com|\.net|\.org|\.to\b|\.am\b|\/)[^)]*\)?\s*$/i
const PLACEHOLDER_TITLE = /^track\s*\d+$/i
/** Short-link hosts of the time, where the uploader is the path: i.am/tunes4free. */
const REDIRECTORS = new Set(['i.am', 'beam.to', 'kickme.to', 'listen.to', 'siam.to', 'hello.to', 'listen.at'])
const URL = /(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(\/[\w.-]+)?/i

const FEATURED = /\s+(?:feat\.?|featuring|ft\.|with)\s+/i
/** 'vs.', 'n' and the ' / ' MusicBrainz and Navidrome join artists with */
const JOINT = /\s+(?:vs\.?|n)\s+|\s+\/\s+/i
const MEGAMIX = /mega\s*mix|mini\s*mix/i
const VERSIONS: [RegExp, Version][] = [
  [/\bremix\b|\brmx\b|\bmix$/i, 'remix'],
  [/\bacoustic\b|\bunplugged\b/i, 'acoustic'],
  [/\blive\b/i, 'live'],
  [/\bradio edit\b/i, 'radio-edit'],
  [/\balbum version\b/i, 'album-version'],
  [/\binstrumental\b/i, 'instrumental'],
]
const REMIXER = /^(.+?)\s+(?:remix|rmx)$/i

/** Comparison key without spaces, so 'Cant' and "Can't" agree. */
const squash = (s: string): string => norm(s).replace(/ /g, '')

const realAlbum = (s: string): boolean => known(s) && !JUNK_ALBUM.test(s.trim())

const onlyId3v1 = (f: FileInfo): boolean => {
  const formats = Object.keys(f.raw)
  return formats.length > 0 && formats.every((k) => k === 'ID3v1')
}

/** The tag stopped at ID3v1's 30 characters and the filename has the rest. */
const truncated = (value: string, full: string, f: FileInfo): boolean =>
  onlyId3v1(f) && value.length >= ID3V1_FIELD - ID3V1_SLACK && squash(full).length > squash(value).length && squash(full).startsWith(squash(value))

/** 'Artist - Title' or 'DJ - Performer - Title' from a filename, without track number or extension. */
function nameParts(path: string): string[] {
  let { stem } = trackPrefix(basename(path))
  while (AUDIO.has(ext(stem))) stem = stem.slice(0, -ext(stem).length - 1) // 'Song.mp3.mp3'
  return stem.split(' - ').map((s) => s.trim()).filter(Boolean)
}

/** The parenthesised parts and the part after the last ' - ': where a title names its version. */
function decorations(title: string): string[] {
  const out = [...title.matchAll(/\(([^)]*)\)?/g)].map((m) => m[1].trim())
  const dash = title.lastIndexOf(' - ')
  if (dash > 0) out.push(title.slice(dash + 3).trim())
  return out
}

const versionIn = (decoration: string): Version | undefined => VERSIONS.find(([re]) => re.test(decoration))?.[1]

export function versionOf(title: string): Version {
  if (MEGAMIX.test(title)) return 'megamix'
  for (const d of decorations(title)) {
    const v = versionIn(d)
    if (v) return v
  }
  return 'original'
}

/** The title without the decoration that names its version: 'Tides - Harbour remix' -> 'Tides'. */
export function baseTitle(title: string): string {
  let t = title.replace(/\s*\([^)]*\)?/g, '')
  const dash = t.lastIndexOf(' - ')
  if (dash > 0 && versionIn(t.slice(dash + 3))) t = t.slice(0, dash)
  return t.trim() || title
}

/** Credits in an artist field and a title: 'Velvet Coast Featuring Mara', 'Tides (Harbour Remix)'.
 *  '&' and 'and' stay inside the name: 'Simon & Garfunkel' is one act. */
export function creditsOf(artist: string, title: string): Credit[] {
  const credits: Credit[] = []
  const [main, ...featured] = artist.split(FEATURED)
  for (const name of main.split(JOINT)) if (name.trim()) credits.push({ name: name.trim(), role: 'main' })
  for (const name of featured) if (name.trim()) credits.push({ name: name.trim(), role: 'featured' })
  for (const d of decorations(title)) {
    const m = REMIXER.exec(d)
    if (m) credits.push({ name: m[1].trim(), role: 'remixer' })
  }
  return credits
}

export function lengthOf(seconds: number): Length {
  if (seconds < SHORT) return 'short'
  if (seconds < EXTENDED) return 'song'
  if (seconds < MIX) return 'extended'
  return 'mix'
}

const BITRATES: [number, string][] = [[320, '320 kbps'], [224, '224-256 kbps'], [160, '160-192 kbps'], [128, '128 kbps'], [0, 'under 128 kbps']]
const bitrateOf = (f: FileInfo): string => {
  if (f.audio?.lossless) return 'lossless'
  const kbps = Math.round((f.audio?.bitrate ?? 0) / KBPS)
  if (!kbps) return 'unknown'
  return BITRATES.find(([min]) => kbps >= min)?.[1] ?? 'unknown'
}

/** The sites and uploader handles a file names in its comments, album and artist. */
function sourcesOf(f: FileInfo): string[] {
  const comments = ((f.extra.comment ?? []) as ({ text?: string } | string)[]).map((c) => (typeof c === 'string' ? c : c.text ?? ''))
  const out = new Set<string>()
  for (const text of [...comments, f.tags.album, f.tags.artist]) {
    const m = URL.exec(text)
    if (!m) continue
    const host = m[1].toLowerCase()
    const handle = m[2]?.slice(1).toLowerCase()
    out.add(REDIRECTORS.has(host) && handle ? `${host}/${handle}` : host)
  }
  return [...out]
}

/** One DJ's set: every file tagged with the same artist and named 'DJ - Performer - Title'. */
function isDjMix(folder: Folder): boolean {
  const artists = new Set(folder.files.map((f) => squash(f.tags.artist)).filter(Boolean))
  if (artists.size !== 1) return false
  const [dj] = artists
  const named = folder.files.filter((f) => {
    const parts = nameParts(f.path)
    return parts.length >= 3 && squash(parts[0]) === dj
  })
  return named.length / folder.files.length >= OWNER_SHARE
}

/** Track numbers that two files of the folder both claim. */
function collisions(files: { track?: number }[]): number[] {
  const seen = new Map<number, number>()
  for (const { track } of files) if (track) seen.set(track, (seen.get(track) ?? 0) + 1)
  return [...seen].filter(([, n]) => n > 1).map(([t]) => t).sort((a, b) => a - b)
}

export function folderKind(folder: Folder): { kind: FolderKind; reason: string } {
  if (folder.class !== 'album' && folder.class !== 'compilation') return { kind: folder.class, reason: `inventory class ${folder.class}` }
  if (isDjMix(folder)) return { kind: 'dj-mix', reason: "one artist tag and 'DJ - Performer - Title' filenames" }
  const name = norm(basename(folder.dir))
  if (GENERIC.has(name)) return { kind: 'loose', reason: `the folder name '${basename(folder.dir)}' names a pile, not an album` }
  const albums = new Map<string, number>()
  for (const f of folder.files) if (realAlbum(f.tags.album)) albums.set(squash(f.tags.album), (albums.get(squash(f.tags.album)) ?? 0) + 1)
  const top = Math.max(0, ...albums.values()) / folder.files.length
  if (albums.size >= LOOSE_ALBUMS && top < OWNER_SHARE) return { kind: 'loose', reason: `${albums.size} different albums tagged, none on 60% of the files` }
  const numbered = folder.files.map((f) => ({ track: Number(f.tags.track) || undefined }))
  if (collisions(numbered).length && top < OWNER_SHARE) return { kind: 'loose', reason: 'track numbers collide and no album holds the folder' }
  return { kind: folder.class, reason: `inventory class ${folder.class}` }
}

const PLANNED: FolderKind[] = ['album', 'compilation', 'disc', 'dj-mix']

/** Title, artist and credits for one file, repairing what the tags got wrong where the filename knows better. */
function identify(f: FileInfo, kind: FolderKind, match?: TrackMatch): Pick<Track, 'title' | 'artist' | 'credits' | 'evidence' | 'issues'> {
  const evidence: string[] = []
  const issues: string[] = []
  const parts = nameParts(f.path)
  let title = f.tags.title.trim()
  let artist = f.tags.artist.trim()
  let dj = ''

  if (kind === 'dj-mix' && parts.length >= 3) {
    dj = artist || parts[0]
    artist = parts[1]
    if (!known(title) || truncated(title, `${parts[1]} - ${parts[2]}`, f) || squash(title).startsWith(squash(parts[1]))) title = parts.slice(2).join(' - ')
    evidence.push('performer and title from the DJ mix filename')
  }
  if (AUDIO.has(ext(title)) && title.includes('.')) {
    title = title.slice(0, -ext(title).length - 1)
    evidence.push('title carried the file extension')
  }
  const fileTitle = parts.length >= 2 ? parts.slice(1).join(' - ') : ''
  if (PLACEHOLDER_TITLE.test(title) && fileTitle) {
    title = fileTitle
    evidence.push('placeholder title replaced from the filename')
  } else if (!known(title) && fileTitle) {
    title = fileTitle
    evidence.push('title from the filename')
  } else if (fileTitle && truncated(title, fileTitle, f)) {
    title = fileTitle
    evidence.push('ID3v1 cut the title at 30 characters; the filename has it whole')
  }
  if (WATERMARK.test(artist)) {
    artist = artist.replace(WATERMARK, '').trim()
    evidence.push("ripper's watermark removed from the artist")
  }
  if (!known(artist) && parts.length >= 2) {
    artist = parts[0]
    evidence.push('artist from the filename')
  }
  if (match?.title && match.artist) {
    if (squash(match.title) !== squash(title)) evidence.push(`MusicBrainz title, was '${title}'`)
    if (squash(match.artist) !== squash(artist)) evidence.push(`MusicBrainz artist, was '${artist}'`)
    title = ascii(match.title)
    artist = ascii(match.artist)
  }
  if (!known(title)) issues.push(parts.length < 2 ? `no title, and the filename '${basename(f.path)}' is a code, not a name` : 'no title')
  if (!known(artist)) issues.push('no artist')
  const credits = creditsOf(artist, title)
  if (dj) credits.push({ name: dj, role: 'dj' })
  return { title, artist, credits, evidence, issues }
}

/** Of title, artist, album, track and year: all five untouched is good, three or more is fair. */
const FAIR_FIELDS = 3
function quality(t: Pick<Track, 'title' | 'artist' | 'album' | 'track' | 'year' | 'evidence'>): Quality {
  const checks = [known(t.title), known(t.artist), realAlbum(t.album), !!t.track, !!t.year]
  const fields = checks.filter(Boolean).length
  if (fields === checks.length && !t.evidence.length) return 'good'
  return fields >= FAIR_FIELDS ? 'fair' : 'poor'
}

/** Groups keyed by comparison key and named by the most common spelling, sorted by key. */
function group<T>(items: T[], keysOf: (t: T) => string[], id: (t: T) => string, keyOf: (name: string) => string = squash): Group[] {
  const groups = new Map<string, { spellings: Map<string, number>; tracks: string[] }>()
  for (const it of items) {
    for (const name of new Set(keysOf(it))) {
      const key = keyOf(name) || name
      const g = groups.get(key) ?? { spellings: new Map<string, number>(), tracks: [] as string[] }
      g.spellings.set(name, (g.spellings.get(name) ?? 0) + 1)
      g.tracks.push(id(it))
      groups.set(key, g)
    }
  }
  return [...groups]
    .map(([key, g]) => ({ key, name: [...g.spellings].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0], tracks: g.tracks.sort() }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

/** `excerpt`: a few tracks of a release filed from elsewhere (a single's remix), whose numbering gaps say nothing. */
function albumIssues(tracks: Track[], reason: string, kind: FolderKind, match?: AlbumMatch, excerpt = false): string[] {
  const issues: string[] = []
  const numbers = tracks.map((t) => t.track).filter((n): n is number => !!n)
  const dupes = collisions(tracks.filter((t) => (t.disc ?? 1) === 1))
  if (dupes.length) issues.push(`track ${dupes.join(', ')} claimed by more than one file`)
  if (match) {
    // the release's tracklist knows what is missing; a numbering gap is only a guess
    const discs = new Set(match.missing.map((m) => m.disc)).size > 1 || match.missing.some((m) => m.disc > 1)
    const missing = match.missing.map((m) => `${discs ? `${m.disc}.` : ''}${m.track} (${m.title})`)
    if (missing.length) issues.push(`missing track ${missing.join(', ')}`)
    const extra = tracks.filter((t) => t.identified !== 'album')
    if (extra.length) issues.push(`not on ${match.title}: ${extra.map((t) => t.title).join(', ')}`)
  } else if (numbers.length && !excerpt) {
    // gaps the unnumbered tracks could fill are not yet missing: Play tagged 10-18 has its 1-9 untagged
    const missing = Array.from({ length: Math.max(...numbers) }, (_, i) => i + 1).filter((n) => !numbers.includes(n))
    if (missing.length > tracks.length - numbers.length) issues.push(`missing track ${missing.join(', ')}`)
  }
  const unnumbered = tracks.length - numbers.length
  if (unnumbered && !match && !excerpt) issues.push(`${unnumbered} of ${tracks.length} tracks have no number`)
  const years = new Set(tracks.map((t) => t.year).filter(Boolean))
  // tracks of a mix or a compilation come from different years; an album's should not
  if (years.size > 1 && !match && (kind === 'album' || kind === 'disc')) issues.push(`years disagree: ${[...years].sort().join(', ')}`)
  if (!match && reason.includes('album from folder name')) issues.push('album named after the folder; identify or a person should name it')
  return issues
}

/** Categories for an inventory, using the planned album-level tags of the dry run where there is one. */
/** A path relative to the root that holds it, prefixed by the root's name when there are several. */
export function relPath(roots: string[], p: string): string {
  const root = roots.find((r) => p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`)) ?? ''
  const r = relative(root, p) || '.'
  return roots.length > 1 ? `${basename(root)}/${r}` : r
}

const DECIBELS = 10
const ROUND = 10
/** Integrated loudness of tracks played in a row, weighting each by its length: the album's ReplayGain basis. */
function albumLufs(members: Track[]): number | undefined {
  if (!members.length || members.some((t) => !t.loudness || !t.duration)) return undefined
  const total = members.reduce((n, t) => n + t.duration, 0)
  const energy = members.reduce((n, t) => n + t.duration * DECIBELS ** ((t.loudness?.lufs ?? 0) / DECIBELS), 0)
  return Math.round(DECIBELS * Math.log10(energy / total) * ROUND) / ROUND
}

/** Loudness bands in LUFS, loudest first: what a listener hears as a jump between two tracks. */
const LOUDNESS: [number, string][] = [[-9, 'over -9 LUFS'], [-12, '-12 to -9 LUFS'], [-15, '-15 to -12 LUFS'], [-Infinity, 'under -15 LUFS']]

/** Categories for an inventory, using the planned album-level tags of the dry run where there is one and what
 *  enrich found online where it ran. */
export function categorize(inv: Inventory, decisions: Decision[] = [], enrichment?: Enrichment): Categories {
  const byPath = new Map(decisions.map((d) => [d.path, d]))
  const rel = (p: string): string => relPath(inv.roots, p)
  const tracks: Track[] = []
  const folders: FolderGroup[] = []
  const albumOf = new Map<string, { album: Album; reason: string; members: Track[] }>()
  const fileOf = new Map<string, FileInfo>()
  const songOf = new Map<string, string>()
  // the planned album of the files a release matched, per folder: the album the folder's other files are compared with
  const folderAlbum = new Map<string, string>()
  for (const folder of inv.folders) {
    const onRelease = folder.files.find((f) => enrichment?.tracks[rel(f.path)]?.via === 'album')
    if (onRelease) folderAlbum.set(folder.dir, (byPath.get(onRelease.path)?.after ?? onRelease.tags).album)
  }

  for (const folder of inv.folders) {
    const { kind, reason } = folderKind(folder)
    folders.push({ path: rel(folder.dir), kind, reason, tracks: folder.files.length })
    for (const f of folder.files) {
      const d = byPath.get(f.path)
      const planned: Tags = PLANNED.includes(kind) ? d?.after ?? f.tags : f.tags
      const m = enrichment?.tracks[rel(f.path)]
      const onRelease = m?.via === 'album' && PLANNED.includes(kind)
      // a file of a matched folder that is not on the release but names the same album still belongs to it
      const release = PLANNED.includes(kind) ? enrichment?.albums[rel(folder.dir)] : undefined
      const sameAlbum = !!release && squash(planned.album) === squash(folderAlbum.get(folder.dir) ?? '')
      const who = identify(f, kind, m)
      // a recording MusicBrainz files under another album than the folder's: a single's remix filed with the album
      const elsewhere = !!release && !!m?.release && m.releaseGroup !== release.releaseGroup
      // its own release: a track's outside an album folder, or one from elsewhere; a folder-mate naming the folder's
      // album joins its release
      const own = m?.via === 'recording' && !!m.release && (!PLANNED.includes(kind) || elsewhere)
      const joins = !onRelease && !own && sameAlbum
      const album = onRelease || own
        ? ascii(m?.album ?? planned.album)
        : joins ? ascii(release.title) : !PLANNED.includes(kind) ? (realAlbum(f.tags.album) ? f.tags.album : '') : planned.album
      const albumartist = onRelease || own
        ? ascii(m?.albumartist ?? planned.albumartist)
        : joins
          ? ascii(release.artist)
          : kind === 'loose' ? '' : kind === 'dj-mix' ? who.credits.find((c) => c.role === 'dj')?.name ?? planned.albumartist : planned.albumartist
      const filed = onRelease || joins ? { release: release?.release, releaseGroup: release?.releaseGroup, cover: release?.cover } : own ? { release: m?.release, releaseGroup: m?.releaseGroup, cover: m?.cover } : {}
      const year = m?.year ?? (Number(planned.year) || undefined)
      const track: Track = {
        path: rel(f.path),
        folder: rel(folder.dir),
        title: who.title,
        artist: who.artist,
        credits: who.credits,
        album,
        albumartist,
        track: onRelease || own ? m?.track : Number(planned.track) || undefined,
        disc: onRelease || own ? m?.disc : Number(planned.disc) || undefined,
        year,
        genre: m?.genres?.length ? titleCase(m.genres[0]) : JUNK_GENRES.has(planned.genre.trim().toLowerCase()) ? '' : planned.genre.trim(),
        duration: f.duration,
        length: lengthOf(f.duration),
        version: versionOf(who.title),
        song: '',
        kbps: Math.round((f.audio?.bitrate ?? 0) / KBPS),
        tagQuality: 'poor',
        evidence: who.evidence,
        issues: who.issues,
        identified: m?.via,
        recording: m?.recording,
        ...filed,
        genres: m?.genres?.map(titleCase),
        lyrics: m?.lyrics,
        loudness: m?.loudness,
      }
      if (!m?.via) delete track.identified
      for (const k of ['recording', 'release', 'releaseGroup', 'cover', 'genres', 'lyrics', 'loudness'] as const) if (track[k] === undefined) delete track[k]
      const tagged = planned.genre.trim()
      if (m?.genres?.length && known(tagged) && !JUNK_GENRES.has(tagged.toLowerCase()) && squash(tagged) !== squash(track.genre))
        track.evidence.push(`MusicBrainz genre, was '${tagged}'`)
      const song = `${who.credits.find((c) => c.role === 'main')?.name ?? who.artist} - ${baseTitle(who.title)}`
      track.song = known(who.title) ? squash(song) : ''
      track.tagQuality = quality(track)
      tracks.push(track)
      fileOf.set(track.path, f)
      songOf.set(track.path, song)
      if (!PLANNED.includes(kind) || !album) continue
      const key = `${squash(albumartist)}|${squash(album)}`
      const entry = albumOf.get(key) ?? {
        album: { key, name: album, albumartist, kind, folder: rel(folder.dir), years: [], issues: [], tracks: [] },
        reason: d?.reason ?? '',
        members: [],
      }
      entry.members.push(track)
      albumOf.set(key, entry)
    }
  }

  // a tagged genre MusicBrainz names elsewhere in the library takes its spelling: 'Hip-Hop' next to 'Hip Hop'
  const spelling = new Map(tracks.flatMap((t) => t.genres ?? []).map((g) => [squash(g), g]))
  for (const t of tracks) {
    const as = spelling.get(squash(t.genre))
    if (t.genres || !as || as === t.genre) continue
    t.evidence.push(`genre spelled as MusicBrainz does, was '${t.genre}'`)
    t.genre = as
  }

  const albums = [...albumOf.values()]
    .map(({ album, reason, members }) => {
      // the release its tracks were filed under; the folder's match only when it is that release
      const filed = members[0]?.release && members.every((t) => t.release === members[0].release) ? members[0] : undefined
      const folderMatch = enrichment?.albums[album.folder]
      const match = folderMatch?.release === filed?.release ? folderMatch : undefined
      const lufs = albumLufs(members)
      return {
        ...album,
        years: [...new Set(members.map((t) => t.year).filter((y): y is number => !!y))].sort(),
        issues: albumIssues(members, reason, album.kind, match, !!filed && !match),
        tracks: members.map((t) => t.path).sort(),
        ...(filed?.release ? { release: filed.release } : {}),
        ...(filed?.cover ? { cover: filed.cover } : {}),
        ...(lufs !== undefined ? { lufs } : {}),
      }
    })
    .sort((a, b) => a.key.localeCompare(b.key))

  const path = (t: Track): string => t.path
  const artistGroups = group(tracks, (t) => t.credits.map((c) => c.name).filter((n) => known(n) && !isVarious(n)), path)
  const artists: ArtistGroup[] = artistGroups.map((g) => {
    const mine = tracks.filter((t) => t.credits.some((c) => squash(c.name) === g.key))
    const roles = [...new Set(mine.flatMap((t) => t.credits.filter((c) => squash(c.name) === g.key).map((c) => c.role)))].sort()
    const owned = albums.filter((a) => squash(a.albumartist) === g.key || a.tracks.some((p) => mine.some((t) => t.path === p))).map((a) => a.key)
    return { ...g, roles, albums: owned }
  })
  const decade = (t: Track): string[] => (t.year ? [`${Math.floor(t.year / DECADE) * DECADE}s`] : ['unknown'])
  const same = (name: string): string => name
  const fileFor = (t: Track): FileInfo[] => [fileOf.get(t.path)].filter((f) => f !== undefined)

  return {
    version: CATEGORIES_VERSION,
    summary: {
      tracks: tracks.length,
      folders: folders.length,
      albums: albums.length,
      artists: artists.length,
      seconds: tracks.reduce((n, t) => n + t.duration, 0),
      identified: tracks.filter((t) => t.identified).length,
      covers: albums.filter((a) => a.cover).length,
      lyrics: tracks.filter((t) => t.lyrics === 'synced' || t.lyrics === 'plain').length,
    },
    folders: folders.sort((a, b) => a.path.localeCompare(b.path)),
    albums,
    artists,
    genres: group(tracks, (t) => [t.genre || 'unknown'], path),
    decades: group(tracks, decade, path, same),
    lengths: group(tracks, (t) => [t.length], path, same),
    versions: group(tracks, (t) => [t.version], path, same),
    songs: group(tracks, (t) => (t.song ? [songOf.get(t.path) ?? t.song] : []), path).filter((g) => g.tracks.length > 1),
    tagQuality: group(tracks, (t) => [t.tagQuality], path, same),
    bitrates: group(tracks, (t) => fileFor(t).map(bitrateOf), path, same),
    sources: group(tracks, (t) => fileFor(t).flatMap(sourcesOf), path, same),
    identified: group(tracks, (t) => [t.identified ? `${t.identified} match` : 'not identified'], path, same),
    lyrics: group(tracks, (t) => [t.lyrics ?? 'not checked'], path, same),
    loudness: group(tracks, (t) => [t.loudness ? LOUDNESS.find(([min]) => (t.loudness?.lufs ?? 0) > min)?.[1] ?? '' : 'not measured'], path, same),
    tracks: tracks.sort((a, b) => a.path.localeCompare(b.path)),
  }
}

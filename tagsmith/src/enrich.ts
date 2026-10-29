/** Stage 2 by name, before fingerprints: who the files are according to MusicBrainz, their albums' covers on the
 *  Cover Art Archive, whether LRCLIB has their lyrics, and how loud they are (ffmpeg's EBU R128 meter, the
 *  measure ReplayGain 2 tags are made from). Starts from the offline categories view, so it searches with the
 *  repaired titles and the folder kinds, and returns plain JSON keyed by relative path. Writes nothing. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ascii, baseTitle, categorize, creditsOf, relPath, type Track } from './categories.ts'
import type { Decision } from './decisions.ts'
import type { Inventory } from './inventory.ts'
import type { Fetcher } from './net.ts'
import { isVarious, known, norm } from './text.ts'

export const ENRICH_VERSION = 1
export type Step = 'musicbrainz' | 'covers' | 'lyrics' | 'loudness'
export const STEPS: Step[] = ['musicbrainz', 'covers', 'lyrics', 'loudness']
export type Lyrics = 'synced' | 'plain' | 'instrumental' | 'none'
/** integrated loudness and true peak; gain is what ReplayGain 2 would write for the track */
export type Loudness = { lufs: number; peak: number; gain: number }

export type AlbumMatch = {
  release: string
  releaseGroup: string
  title: string
  artist: string
  year?: number
  /** files of the folder found on the release's tracklist, of all its files */
  matched: number
  files: number
  /** the release's tracks no file matched */
  missing: { disc: number; track: number; title: string }[]
  /** a Cover Art Archive thumbnail of the front */
  cover?: string
  /** the release group's MusicBrainz genres, most voted first */
  genres?: string[]
}

export type TrackMatch = {
  via?: 'album' | 'recording'
  recording?: string
  title?: string
  artist?: string
  album?: string
  albumartist?: string
  track?: number
  disc?: number
  /** the year the recording or the album first came out */
  year?: number
  /** MusicBrainz ids of the credited artists, in credit order */
  artists?: string[]
  /** MusicBrainz genres of the album's release group, else of the main artist, most voted first */
  genres?: string[]
  /** the release a recording match belongs to (album fields above come from it), and its Cover Art Archive front */
  release?: string
  releaseGroup?: string
  cover?: string
  lyrics?: Lyrics
  loudness?: Loudness
}

export type Enrichment = { version: number; albums: Record<string, AlbumMatch>; tracks: Record<string, TrackMatch> }

/** The fields of a track each step owns. */
export const STEP_FIELDS: Record<Step, (keyof TrackMatch)[]> = {
  musicbrainz: ['via', 'recording', 'title', 'artist', 'album', 'albumartist', 'track', 'disc', 'year', 'artists', 'genres', 'release', 'releaseGroup'],
  covers: ['cover'],
  lyrics: ['lyrics'],
  loudness: ['loudness'],
}

export type EnrichOptions = {
  net: Fetcher
  steps?: Step[]
  /** measures one file; the default runs ffmpeg */
  measure?: (path: string) => Promise<Loudness | undefined>
  /** the last run's answers: without the musicbrainz step, covers and lyrics look up what it found */
  previous?: Enrichment
  onProgress?: (step: Step, done: number, total: number) => void
  /** a lookup that failed after its retries; the file is left without that answer and the run goes on */
  onError?: (step: Step, path: string, error: unknown) => void
}

type MbCredit = { name: string; joinphrase?: string; artist?: { id: string } }
type MbGenres = { genres?: { name: string; count: number }[] }
type MbGroup = MbGenres & { 'first-release-date'?: string }
/** A release as a recording search lists it: its group's types, and the one track of it that is the recording. */
type MbSearchRelease = {
  id: string
  title: string
  status?: string
  date?: string
  'artist-credit'?: MbCredit[]
  'release-group'?: { id: string; 'primary-type'?: string; 'secondary-types'?: string[] }
  media?: { position: number; track?: { number: string; title: string }[] }[]
}
type MbRecording = {
  id: string
  title: string
  score?: number
  length?: number | null
  disambiguation?: string
  'first-release-date'?: string
  'artist-credit'?: MbCredit[]
  releases?: MbSearchRelease[]
}
type MbTrack = { position: number; title: string; length?: number | null; recording: MbRecording; 'artist-credit'?: MbCredit[] }
type MbRelease = {
  id: string
  title: string
  date?: string
  'artist-credit'?: MbCredit[]
  'release-group'?: { id: string; 'first-release-date'?: string }
  media?: { position: number; tracks?: MbTrack[] }[]
}

const MB = 'https://musicbrainz.org/ws/2'
const CAA = 'https://coverartarchive.org'
const LRCLIB = 'https://lrclib.net/api'
const RELEASE_CANDIDATES = 5
/** Popular songs have dozens of live and compilation takes; the original has to be among those compared. */
const RECORDING_CANDIDATES = 25
/** Words this long or longer are searched fuzzily, so 'Lanters' finds 'Lanterns'. */
const FUZZY_FROM = 4
/** A release is the folder's album when it holds at least this share of the folder's files. */
const ALBUM_SHARE = 0.5
const TITLE_ON_RELEASE = 0.8
const TITLE_OF_RECORDING = 0.75
const ARTIST_OF_RECORDING = 0.5
/** Genres kept per album or artist, most voted first. */
const TOP_GENRES = 3
/** A version-labelled title matches when the song is the same and the file's version words are all in theirs. */
const DECORATED = 0.85
const SAME_SONG = 0.9
const WORD_MIN = 3
const FULL_SCORE = 100
/** Seconds two lengths of one recording may differ by; a remix or a live take is usually further off. On a
 *  release whose tracklist already holds the folder the title says more, so the length may differ further. */
const SAME_LENGTH = 20
const ALBUM_LENGTH = 45
/** Candidates this close to the best are equally good matches; the earliest release among them gives the year. */
const NEAR_COST = 10
const LYRICS_LENGTH = 10
const UNKNOWN_LENGTH_COST = 30
/** Per credited artist the file does not name: 'feat. a guest singer' is another take than the band's own. */
const EXTRA_ARTIST_COST = 15
/** A title cut short, by ID3v1 or a filename, still matches when this much of it is there. */
const PREFIX_MIN = 8
const PREFIX_SIMILARITY = 0.9
/** Years after a song's first take that a release still counts as its own. */
const LATE_YEARS = 2
/** Release kinds a loose recording is filed under, preferred first, as Picard's preferred release types do. */
const RELEASE_KINDS = ['Album', 'Single', 'EP']
/** Release group types that are not a studio album: what the second search for a song's album leaves out. */
const NOT_STUDIO = 'compilation OR live OR remix OR "dj-mix" OR demo OR soundtrack OR mixtape'
const REPLAYGAIN_REFERENCE = -18
const CENTS = 100
const MS = 1000
const MEASURE_JOBS = 6
const FFMPEG_BUFFER = 64 * 1024 * 1024

const LUCENE = /[+\-&|!(){}[\]^"~*?:\\/]/g
const DJ_MIX_EXCERPT = /part of .*?\bdj\W?mix/gi
const VERSION_WORDS = /\b(live|demo|acoustic|unplugged|remix|mix|dub|edit|extended|radio|instrumental|karaoke)\b/gi

const squash = (s: string): string => norm(s).replace(/ /g, '')
const terms = (s: string): string =>
  s.replace(LUCENE, ' ').split(/\s+/).filter(Boolean).map((w) => (w.length >= FUZZY_FROM ? `${w}~` : w)).join(' ')
const creditOf = (c: MbCredit[] | undefined): string => (c ?? []).map((a) => a.name + (a.joinphrase ?? '')).join('').trim()
const artistIds = (c: MbCredit[] | undefined): string[] => (c ?? []).map((a) => a.artist?.id).filter((id) => id !== undefined)
const yearOf = (date: string | undefined): number | undefined => Number(date?.slice(0, 4)) || undefined
const seconds = (ms: number | null | undefined): number | undefined => (ms ? Math.round(ms / MS) : undefined)

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = row
  }
  return prev[b.length]
}

/** 0..1 by edit distance over the comparison keys; a title cut short of the other counts as near, a name does not
 *  ('Ada Lane' is not 'Ada Lane n Mo B'). */
export function similarity(a: string, b: string, cut = true): number {
  const x = squash(a)
  const y = squash(b)
  if (!x || !y) return 0
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  const whole = 1 - levenshtein(x, y) / long.length
  if (!cut || short.length < PREFIX_MIN) return whole
  // the start of the longer one, give or take a letter: 'Midnigt Train' begins 'Midnight Train to Nowhere'
  const head = Math.max(...[0, 1].map((d) => 1 - levenshtein(short, long.slice(0, short.length + d)) / (short.length + d)))
  return head >= PREFIX_SIMILARITY ? Math.max(PREFIX_SIMILARITY, whole) : whole
}

/** How well a file's title names a recording's: by spelling, or as the same song whose version label holds all of
 *  the file's ('Tides - Harbour remix' is 'Tides (Lowlight and Harbour remix)'). */
export function titleMatch(ours: string, theirs: string): number {
  const plain = similarity(ours, theirs)
  const words = (s: string) => norm(s).split(' ').filter((w) => w.length >= WORD_MIN)
  const base = new Set(words(baseTitle(ours)))
  const label = words(ours).filter((w) => !base.has(w))
  const all = new Set(words(theirs))
  const same = similarity(baseTitle(ours), baseTitle(theirs), false) >= SAME_SONG && label.length > 0 && label.every((w) => all.has(w))
  return Math.max(plain, same ? DECORATED : 0)
}

const topGenres = (g: MbGenres | undefined): string[] =>
  [...(g?.genres ?? [])].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, TOP_GENRES).map((x) => x.name)

/** Which release track each file is, by title and length; files and tracks are used once. */
function assign(files: Track[], release: MbRelease): Map<string, { track: MbTrack; disc: number }> {
  const tracks = (release.media ?? []).flatMap((m) => (m.tracks ?? []).map((track) => ({ track, disc: m.position })))
  const pairs: { file: string; i: number; score: number }[] = []
  for (const f of files) {
    if (!known(f.title)) continue
    tracks.forEach(({ track }, i) => {
      const length = seconds(track.length ?? track.recording.length)
      if (length && f.duration && Math.abs(length - f.duration) > ALBUM_LENGTH) return
      const score = similarity(f.title, track.title)
      if (score >= TITLE_ON_RELEASE) pairs.push({ file: f.path, i, score })
    })
  }
  const out = new Map<string, { track: MbTrack; disc: number }>()
  const used = new Set<number>()
  for (const p of pairs.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.i - b.i)) {
    if (out.has(p.file) || used.has(p.i)) continue
    out.set(p.file, tracks[p.i])
    used.add(p.i)
  }
  return out
}

async function matchAlbum(net: Fetcher, name: string, artist: string, files: Track[]): Promise<{ release: MbRelease; on: Map<string, { track: MbTrack; disc: number }> } | undefined> {
  // exact words first, so 'Urbal Nights' is not crowded out by the fuzzy 'Urban Nights'; then fuzzy for misspellings
  const ids: string[] = []
  for (const fuzzy of [false, true]) {
    const words = (s: string) => (fuzzy ? terms(s) : s.replace(LUCENE, ' ').trim())
    const query = isVarious(artist) || !known(artist) ? `release:(${words(name)})` : `release:(${words(name)}) AND artist:(${words(artist)})`
    const search = await net.json<{ releases?: { id: string }[] }>(`${MB}/release?query=${encodeURIComponent(query)}&fmt=json&limit=${RELEASE_CANDIDATES}`)
    for (const { id } of search?.releases ?? []) if (!ids.includes(id)) ids.push(id)
  }
  let best: { release: MbRelease; on: Map<string, { track: MbTrack; disc: number }>; extra: number } | undefined
  for (const id of ids) {
    const release = await net.json<MbRelease>(`${MB}/release/${id}?inc=recordings+artist-credits+release-groups&fmt=json`)
    if (!release) continue
    const on = assign(files, release)
    const size = (release.media ?? []).reduce((n, m) => n + (m.tracks?.length ?? 0), 0)
    const extra = Math.abs(size - files.length)
    const better =
      !best ||
      on.size > best.on.size ||
      (on.size === best.on.size && extra < best.extra) ||
      (on.size === best.on.size && extra === best.extra && (release.date ?? '9') < (best.release.date ?? '9'))
    if (better) best = { release, on, extra }
  }
  return best && best.on.size / files.length >= ALBUM_SHARE ? best : undefined
}

async function matchRecording(net: Fetcher, t: Track): Promise<Picked | undefined> {
  const search = async (query: string) =>
    (await net.json<{ recordings?: MbRecording[] }>(`${MB}/recording?query=${encodeURIComponent(query)}&fmt=json&limit=${RECORDING_CANDIDATES}`))?.recordings ?? []
  let pool = await search(`recording:(${terms(t.title)}) AND artist:(${terms(t.artist)})`)
  let found = pick(t, pool)
  if (!found) {
    // a fuzzy artist can drift (a short, run-together name finds other acts); the title alone, compared by artist
    // afterwards, finds the right one
    pool = await search(`recording:(${t.title.replace(LUCENE, ' ').trim()})`)
    found = pick(t, pool)
  }
  const artist = found?.r['artist-credit']?.[0]?.artist?.id
  if (!found || !artist) return found
  // a hit has hundreds of takes on compilations (a hit can have 400) and the album's may not be among the
  // first; asked for by the artist's id on official studio albums, it is
  const studio = await search(`recording:"${found.r.title.replace(/["\\]/g, ' ')}" AND arid:${artist} AND status:official AND primarytype:album AND NOT secondarytype:(${NOT_STUDIO})`)
  return pick(t, [...pool, ...studio], found)
}

/** `editions`: every release of the chosen release group that holds a fitting take, so songs filed under one
 *  album can agree on one edition of it. */
type Filed = { r: MbRecording; release: MbSearchRelease; studio: boolean; editions: { r: MbRecording; release: MbSearchRelease }[] }
type Picked = { r: MbRecording; year?: number; release?: Filed }

/** The best fit among `recordings`; with `found`, the recording is kept and only its album and year are chosen again
 *  from the takes by the same credit that fit as well. */
function pick(t: Track, recordings: MbRecording[], found?: Picked): Picked | undefined {
  const ours = creditsOf(t.artist, '').map((c) => c.name)
  const versions = (s: string) => [...new Set([...s.matchAll(VERSION_WORDS)].map((m) => m[1].toLowerCase()))].sort().join(' ')
  const fits: { r: MbRecording; cost: number }[] = []
  for (const r of recordings) {
    const names = (r['artist-credit'] ?? []).map((c) => c.name)
    // every act the file credits is on the recording, or the whole credit reads the same
    const artistOk =
      similarity(t.artist, creditOf(r['artist-credit']), false) >= ARTIST_OF_RECORDING ||
      ours.every((o) => names.some((n) => similarity(o, n, false) >= TITLE_OF_RECORDING))
    // MusicBrainz's score is relative to its best hit, so it ranks but does not decide
    if (titleMatch(t.title, r.title) < TITLE_OF_RECORDING || !artistOk) continue
    // a live, remixed or dub take is not the file unless the file says it is one, and the other way round
    // 'part of a "Kontor" DJ-mix' says where an excerpt comes from, not that it is a remix
    const note = (r.disambiguation ?? '').replace(DJ_MIX_EXCERPT, '')
    if (versions(`${note} ${r.title}`) !== versions(t.title)) continue
    const length = seconds(r.length)
    const off = length && t.duration ? Math.abs(length - t.duration) : UNKNOWN_LENGTH_COST
    if (length && t.duration && off > SAME_LENGTH) continue
    const extra = names.filter((n) => !ours.some((o) => similarity(o, n, false) >= TITLE_OF_RECORDING)).length
    const whole = similarity(t.artist, creditOf(r['artist-credit']), false) >= TITLE_OF_RECORDING
    fits.push({ r, cost: off + (FULL_SCORE - (r.score ?? 0)) / 2 + (whole ? 0 : extra * EXTRA_ARTIST_COST) })
  }
  if (!fits.length) return found
  const floor = Math.min(...fits.map((f) => f.cost))
  const best =
    found?.r ??
    fits
      .filter((f) => f.cost <= floor + NEAR_COST)
      .sort((a, b) => (a.r['first-release-date'] || '9').localeCompare(b.r['first-release-date'] || '9') || a.cost - b.cost || a.r.id.localeCompare(b.r.id))[0].r
  // MusicBrainz keeps reissues as recordings of their own; the earliest take that fits, by the same credit, is the
  // song's year
  const credit = squash(creditOf(best['artist-credit']))
  const same = fits.filter((f) => squash(creditOf(f.r['artist-credit'])) === credit).map((f) => f.r)
  const years = same.map((r) => yearOf(r['first-release-date'])).filter((y) => y !== undefined)
  const year = years.length ? Math.min(...years) : found?.year
  // the album is chosen among takes of this very song, so filing it never swaps it for another mix ('Tides' for
  // 'Tides 2002'); a label such as '(album version)' is the same song, and the version words already agree
  const release = albumFor(same.filter((r) => squash(ascii(baseTitle(r.title))) === squash(ascii(baseTitle(best.title)))), year)
  if (found && !release) return found
  return { r: release?.r ?? best, year, release }
}

/** The release a song is filed under, from every release its takes by the same credit appeared on: official
 *  before bootleg, out with the song before years later, a plain release before a compilation, soundtrack, live or
 *  remix album, an album before a single or EP, then the earliest. */
function albumFor(recordings: MbRecording[], songYear?: number): Filed | undefined {
  const rank = (x: MbSearchRelease): (number | string)[] => {
    const g = x['release-group']
    const kind = RELEASE_KINDS.indexOf(g?.['primary-type'] ?? '')
    // out years after the song: a re-recording, an anniversary edition or a compilation nobody marked as one
    const late = songYear !== undefined && (yearOf(x.date) ?? songYear) > songYear + LATE_YEARS
    return [x.status === 'Official' ? 0 : 1, late ? 1 : 0, g?.['secondary-types']?.length ? 1 : 0, kind < 0 ? RELEASE_KINDS.length : kind, x.date || '9', x.id]
  }
  const order = (a: (number | string)[], b: (number | string)[]): number => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
    return 0
  }
  const all = recordings.flatMap((r) => (r.releases ?? []).map((release) => ({ r, release, rank: rank(release) })))
  const first = all.sort((a, b) => order(a.rank, b.rank))[0]
  if (!first) return undefined
  const group = first.release['release-group']?.id
  const editions = all.filter((x) => x.release['release-group']?.id === group).map(({ r, release }) => ({ r, release }))
  // an official album out with the song that is not a compilation, soundtrack, live or remix album: the song's home
  return { r: first.r, release: first.release, studio: first.rank.slice(0, 4).every((x) => x === 0), editions }
}

async function cover(net: Fetcher, release: string, group: string): Promise<string | undefined> {
  type Images = { images?: { front?: boolean; image?: string; thumbnails?: Record<string, string> }[] }
  for (const url of [`${CAA}/release/${release}`, `${CAA}/release-group/${group}`]) {
    const front = (await net.json<Images>(url))?.images?.find((i) => i.front)
    const thumb = front?.thumbnails?.['250'] ?? front?.thumbnails?.small ?? front?.image
    if (thumb) return thumb.replace(/^http:/, 'https:')
  }
  return undefined
}

/** LRCLIB's lyrics for a track: synced (LRC) when it has them, else plain. The same requests as the enrich step
 *  makes, so after enrich the cache answers them and apply can embed the text without asking again. */
export async function findLyrics(net: Fetcher, title: string, artist: string, album: string, duration: number): Promise<{ kind: Lyrics; text?: string }> {
  type Hit = { duration?: number; instrumental?: boolean; plainLyrics?: string | null; syncedLyrics?: string | null }
  const kind = (h: Hit): Lyrics => (h.instrumental ? 'instrumental' : h.syncedLyrics ? 'synced' : h.plainLyrics ? 'plain' : 'none')
  const found = (h: Hit) => ({ kind: kind(h), text: h.syncedLyrics || h.plainLyrics || undefined })
  // with the album first; LRCLIB's own album name may differ ('Total Hits Of '98'), so then without it
  for (const withAlbum of album ? [true, false] : [false]) {
    const q = new URLSearchParams({ track_name: title, artist_name: artist, duration: String(duration) })
    if (withAlbum) q.set('album_name', album)
    const hit = await net.json<Hit>(`${LRCLIB}/get?${q}`)
    // a record with no text is not an answer: another album's record or a search may have the words
    if (hit && kind(hit) !== 'none') return found(hit)
  }
  const hits = await net.json<Hit[]>(`${LRCLIB}/search?${new URLSearchParams({ track_name: title, artist_name: artist })}`)
  const near = (hits ?? [])
    .filter((h) => h.duration && Math.abs(h.duration - duration) <= LYRICS_LENGTH)
    .sort((a, b) => Math.abs((a.duration ?? 0) - duration) - Math.abs((b.duration ?? 0) - duration))[0]
  return near ? found(near) : { kind: 'none' }
}

const lyrics = async (net: Fetcher, title: string, artist: string, album: string, duration: number): Promise<Lyrics> =>
  (await findLyrics(net, title, artist, album, duration)).kind

const run = promisify(execFile)

/** EBU R128 integrated loudness and true peak by ffmpeg; undefined when ffmpeg is missing or the file will not decode. */
export async function measure(path: string): Promise<Loudness | undefined> {
  try {
    const args = ['-hide_banner', '-nostats', '-i', path, '-map', '0:a:0', '-filter:a', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-']
    const { stderr } = await run('ffmpeg', args, { maxBuffer: FFMPEG_BUFFER })
    const lufs = Number([...stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].at(-1)?.[1])
    const peak = Number([...stderr.matchAll(/Peak:\s+(-?[\d.]+) dBFS/g)].at(-1)?.[1])
    if (!Number.isFinite(lufs)) return undefined
    return { lufs, peak: Number.isFinite(peak) ? peak : 0, gain: Math.round((REPLAYGAIN_REFERENCE - lufs) * CENTS) / CENTS }
  } catch {
    return undefined
  }
}

async function pool<T>(items: T[], jobs: number, work: (t: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async () => {
    while (next < items.length) await work(items[next++])
  }))
}

export async function enrich(inv: Inventory, decisions: Decision[], opts: EnrichOptions): Promise<Enrichment> {
  const steps = new Set(opts.steps ?? STEPS)
  const { net } = opts
  const attempt = async <T>(step: Step, path: string, work: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await work()
    } catch (e) {
      opts.onError?.(step, path, e)
      return undefined
    }
  }
  const view = categorize(inv, decisions)
  const out: Enrichment = { version: ENRICH_VERSION, albums: {}, tracks: {} }
  const entry = (path: string): TrackMatch => (out.tracks[path] ??= {})
  if (!steps.has('musicbrainz') && opts.previous) {
    out.albums = structuredClone(opts.previous.albums)
    for (const [path, m] of Object.entries(opts.previous.tracks)) {
      const found = Object.entries(m).filter(([f]) => STEP_FIELDS.musicbrainz.includes(f as keyof TrackMatch))
      if (found.length) out.tracks[path] = Object.fromEntries(found)
    }
  }
  const byPath = new Map(view.tracks.map((t) => [t.path, t]))
  const abs = new Map(inv.folders.flatMap((f) => f.files.map((file) => [relPath(inv.roots, file.path), file.path] as const)))

  if (steps.has('musicbrainz')) {
    let done = 0
    for (const album of view.albums) {
      opts.onProgress?.('musicbrainz', ++done, view.albums.length)
      const files = album.tracks.map((p) => byPath.get(p)).filter((t) => t !== undefined)
      const found = await attempt('musicbrainz', album.folder, () => matchAlbum(net, album.name, album.albumartist, files))
      if (!found) continue
      const { release, on } = found
      const group = release['release-group']
      const year = yearOf(group?.['first-release-date']) ?? yearOf(release.date)
      const used = new Set([...on.values()].map((v) => v.track.recording.id))
      out.albums[album.folder] = {
        release: release.id,
        releaseGroup: group?.id ?? '',
        title: release.title,
        artist: creditOf(release['artist-credit']),
        year,
        matched: on.size,
        files: files.length,
        missing: (release.media ?? []).flatMap((m) => (m.tracks ?? []).filter((t) => !used.has(t.recording.id)).map((t) => ({ disc: m.position, track: t.position, title: t.title }))),
      }
      for (const [path, { track, disc }] of on) {
        Object.assign(entry(path), {
          via: 'album',
          recording: track.recording.id,
          title: track.title,
          artist: creditOf(track['artist-credit']) || creditOf(release['artist-credit']),
          album: release.title,
          albumartist: creditOf(release['artist-credit']),
          track: track.position,
          disc,
          year,
          artists: artistIds(track['artist-credit'] ?? release['artist-credit']),
        })
      }
    }
    const rest = view.tracks.filter((t) => !out.tracks[t.path]?.recording && known(t.title) && known(t.artist))
    const studio = new Set<string>()
    const filed = new Map<string, { r: MbRecording; release: Filed }>()
    done = 0
    for (const t of rest) {
      opts.onProgress?.('musicbrainz', ++done, rest.length)
      const m = await attempt('musicbrainz', t.path, () => matchRecording(net, t))
      if (m) {
        const { r, year, release } = m
        Object.assign(entry(t.path), { via: 'recording', recording: r.id, title: r.title, artist: creditOf(r['artist-credit']), year, artists: artistIds(r['artist-credit']) })
        if (release?.studio) studio.add(t.path)
        if (release) filed.set(t.path, { r, release })
      }
    }
    // songs filed under one album share one edition of it, the one that holds most of them, so a server shows one
    // album and not one per edition; each keeps its own edition where the shared one lacks it
    const byGroup = new Map<string, string[]>()
    for (const [path, f] of filed) {
      const group = f.release.release['release-group']?.id ?? ''
      byGroup.set(group, [...(byGroup.get(group) ?? []), path])
    }
    for (const paths of byGroup.values()) {
      // editions come ranked as albumFor ranks releases; the shared one holds the most songs, then ranks best
      const count = new Map<string, { n: number; rank: number }>()
      for (const p of paths) {
        const ids = [...new Set(filed.get(p)?.release.editions.map((e) => e.release.id))]
        ids.forEach((id, rank) => count.set(id, { n: (count.get(id)?.n ?? 0) + 1, rank: Math.min(count.get(id)?.rank ?? rank, rank) }))
      }
      const shared = [...count].sort(([a, x], [b, y]) => y.n - x.n || x.rank - y.rank || a.localeCompare(b))[0]?.[0]
      for (const p of paths) {
        const f = filed.get(p)
        const edition = f?.release.editions.find((e) => e.release.id === shared) ?? f?.release
        if (!f || !edition) continue
        const on = edition.release
        const medium = on.media?.find((x) => x.track?.length)
        Object.assign(entry(p), {
          recording: edition.r.id,
          release: on.id,
          releaseGroup: on['release-group']?.id ?? '',
          album: on.title,
          albumartist: creditOf(on['artist-credit']) || creditOf(edition.r['artist-credit']),
          ...(Number(medium?.track?.[0]?.number) ? { track: Number(medium?.track?.[0]?.number), disc: medium?.position } : {}),
        })
      }
    }
    // genres: the album's release group where there is one, else the main artist's
    const genresOf = new Map<string, string[]>()
    const group = (id: string, path: string) => attempt('musicbrainz', path, () => net.json<MbGroup>(`${MB}/release-group/${id}?inc=genres&fmt=json`))
    for (const [folder, a] of Object.entries(out.albums)) {
      const g = a.releaseGroup ? await group(a.releaseGroup, folder) : undefined
      if (topGenres(g).length) a.genres = topGenres(g)
    }
    // the release group a recording is filed under gives its genres and, for a studio album, its year: the album's
    // first release, so the album and its songs agree and a demo or a promo out first does not date the song
    const groups = new Map<string, MbGroup | undefined>()
    for (const [path, m] of Object.entries(out.tracks).filter(([, m]) => m.via === 'recording' && m.releaseGroup)) {
      const id = m.releaseGroup ?? ''
      if (!groups.has(id)) groups.set(id, await group(id, path))
      const year = yearOf(groups.get(id)?.['first-release-date'])
      if (studio.has(path) && year) m.year = year
    }
    const named = Object.entries(out.tracks).filter(([, m]) => m.via)
    done = 0
    for (const [path, m] of named) {
      opts.onProgress?.('musicbrainz', ++done, named.length)
      const album = m.via === 'album' ? Object.values(out.albums).find((a) => a.title === m.album)?.genres : m.releaseGroup ? topGenres(groups.get(m.releaseGroup)) : undefined
      const id = m.artists?.[0]
      if (!album?.length && id && !genresOf.has(id)) genresOf.set(id, topGenres(await attempt('musicbrainz', path, () => net.json<MbGenres>(`${MB}/artist/${id}?inc=genres&fmt=json`))))
      const genres = album?.length ? album : id ? genresOf.get(id) : undefined
      if (genres?.length) m.genres = genres
    }
  }

  if (steps.has('covers')) {
    let done = 0
    const albums = Object.values(out.albums)
    for (const a of albums) {
      opts.onProgress?.('covers', ++done, albums.length)
      const found = await attempt('covers', a.release, () => cover(net, a.release, a.releaseGroup))
      if (found) a.cover = found
    }
    // the release each recording match is filed under; one lookup per release
    const releases = new Map<string, string | undefined>()
    const filed = Object.values(out.tracks).filter((m) => m.release)
    done = 0
    for (const m of filed) {
      opts.onProgress?.('covers', ++done, filed.length)
      const id = m.release ?? ''
      if (!releases.has(id)) releases.set(id, await attempt('covers', id, () => cover(net, id, m.releaseGroup ?? '')))
      const found = releases.get(id)
      if (found) m.cover = found
    }
  }

  if (steps.has('lyrics')) {
    let done = 0
    const named = view.tracks.filter((t) => known(out.tracks[t.path]?.title ?? t.title) && known(out.tracks[t.path]?.artist ?? t.artist))
    for (const t of named) {
      opts.onProgress?.('lyrics', ++done, named.length)
      const m = out.tracks[t.path]
      const found = await attempt('lyrics', t.path, () => lyrics(net, m?.title ?? t.title, m?.artist ?? t.artist, m?.album ?? t.album, t.duration))
      if (found) entry(t.path).lyrics = found
    }
  }

  if (steps.has('loudness')) {
    let done = 0
    const meter = opts.measure ?? measure
    await pool(view.tracks, MEASURE_JOBS, async (t) => {
      const path = abs.get(t.path)
      const loud = path ? await meter(path) : undefined
      if (loud) entry(t.path).loudness = loud
      opts.onProgress?.('loudness', ++done, view.tracks.length)
    })
  }

  // sorted keys, so the same answers give the same file
  const sorted = <T>(r: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b)))
  return { version: out.version, albums: sorted(out.albums), tracks: sorted(out.tracks) }
}

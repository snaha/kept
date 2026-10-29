/** The tags an apply stage would write, file by file, with where each value came from: the dry-run rules, a
 *  filename repair, MusicBrainz, the loudness meter, the credits in a title. Built from the inventory (what is on
 *  disk now), the categories view and the enrichment; pure, so the same inputs give the same proposal. Field names
 *  are the ones Navidrome reads (`remixer`, `djmixer`, `replaygain_*`, `musicbrainz_*`). */
import { relPath, type Categories, type Track } from './categories.ts'
import type { Enrichment } from './enrich.ts'
import type { Inventory } from './inventory.ts'
import type { FileInfo } from './tags.ts'
import { norm } from './text.ts'

export const PROPOSAL_VERSION = 1

export type Source = 'rules' | 'filename' | 'musicbrainz' | 'credits' | 'loudness' | 'cover art archive' | 'lrclib'

export type Field =
  | 'title' | 'artist' | 'album' | 'albumartist' | 'track' | 'disc' | 'year' | 'genre' | 'compilation'
  | 'remixer' | 'djmixer'
  | 'musicbrainz_trackid' | 'musicbrainz_albumid' | 'musicbrainz_releasegroupid' | 'musicbrainz_artistid'
  | 'replaygain_track_gain' | 'replaygain_track_peak' | 'replaygain_album_gain' | 'replaygain_album_peak'

export type Change = { field: Field; from: string; to: string; source: Source }

export type FilePlan = {
  path: string
  changes: Change[]
  /** a front cover to embed, and to write as cover.jpg when the folder holds only this album */
  cover?: string
  /** LRCLIB has lyrics to save beside the file as .lrc (synced) or in the lyrics tag (plain) */
  lyrics?: 'synced' | 'plain'
}

export type Proposal = {
  version: number
  summary: { files: number; changed: number; byField: Record<string, number>; bySource: Record<string, number>; covers: number; lyrics: number }
  files: FilePlan[]
}

const REPLAYGAIN_REFERENCE = -18
const DB = 20
const PEAK_DIGITS = 6
const GAIN_DIGITS = 2

const gain = (db: number): string => `${db >= 0 ? '+' : ''}${db.toFixed(GAIN_DIGITS)} dB`
/** ReplayGain peaks are linear sample amplitudes; the meter gives true peak in dBFS. */
const peak = (dbfs: number): string => (10 ** (dbfs / DB)).toFixed(PEAK_DIGITS)

/** What a field holds on disk now, as text: the planned fields from `tags`, the rest from the raw frames. */
export function onDisk(f: FileInfo, field: Field): string {
  switch (field) {
    case 'title': case 'artist': case 'album': case 'albumartist': case 'track': case 'disc': case 'year': case 'genre': case 'compilation':
      return f.tags[field]
    case 'musicbrainz_trackid': return f.tags.mb_recordingid
    case 'musicbrainz_albumid': return f.tags.mb_albumid
    case 'musicbrainz_releasegroupid': return f.tags.mb_releasegroupid
    default: {
      const v = f.extra[field]
      // music-metadata reads ReplayGain as { dB, ratio }: a gain in dB, a peak as its linear ratio
      if (v && typeof v === 'object' && 'dB' in v) {
        const { dB, ratio } = v as { dB: number; ratio: number }
        return field.endsWith('_peak') ? Number(ratio).toFixed(PEAK_DIGITS) : gain(Number(dB))
      }
      return Array.isArray(v) ? v.join('; ') : v === undefined ? '' : String(v)
    }
  }
}

function targets(t: Track, e: Enrichment | undefined, albumLufs: number | undefined, albumPeak: number | undefined): [Field, string, Source][] {
  const m = e?.tracks[t.path]
  const mb = !!m?.via
  const fromMb = (value: string | undefined, ours: string) => !!value && norm(value) === norm(ours) && mb
  const repaired = t.evidence.some((x) => !x.startsWith('MusicBrainz'))
  const nameSource = (value: string | undefined, ours: string): Source => (fromMb(value, ours) ? 'musicbrainz' : repaired ? 'filename' : 'rules')
  // album fields from a MusicBrainz release: the folder's, or the one a loose recording is filed under
  const onRelease = !!t.release
  const out: [Field, string, Source][] = [
    ['title', t.title, nameSource(m?.title, t.title)],
    ['artist', t.artist, nameSource(m?.artist, t.artist)],
    ['album', t.album, onRelease ? 'musicbrainz' : 'rules'],
    ['albumartist', t.albumartist, onRelease ? 'musicbrainz' : 'rules'],
    ['track', t.track ? String(t.track) : '', onRelease ? 'musicbrainz' : 'rules'],
    ['disc', t.disc ? String(t.disc) : '', onRelease ? 'musicbrainz' : 'rules'],
    ['year', t.year ? String(t.year) : '', m?.year ? 'musicbrainz' : 'rules'],
    ['genre', t.genre, t.genres?.length ? 'musicbrainz' : 'rules'],
    ['compilation', t.albumartist === 'Various Artists' ? '1' : '', 'rules'],
    ['remixer', t.credits.filter((c) => c.role === 'remixer').map((c) => c.name).join('; '), 'credits'],
    ['djmixer', t.credits.filter((c) => c.role === 'dj').map((c) => c.name).join('; '), 'credits'],
    ['musicbrainz_trackid', m?.recording ?? '', 'musicbrainz'],
    ['musicbrainz_albumid', t.release ?? '', 'musicbrainz'],
    ['musicbrainz_releasegroupid', t.releaseGroup ?? '', 'musicbrainz'],
    ['musicbrainz_artistid', (m?.artists ?? []).join('; '), 'musicbrainz'],
  ]
  if (t.loudness) {
    out.push(['replaygain_track_gain', gain(REPLAYGAIN_REFERENCE - t.loudness.lufs), 'loudness'])
    out.push(['replaygain_track_peak', peak(t.loudness.peak), 'loudness'])
  }
  if (albumLufs !== undefined && albumPeak !== undefined) {
    out.push(['replaygain_album_gain', gain(REPLAYGAIN_REFERENCE - albumLufs), 'loudness'])
    out.push(['replaygain_album_peak', peak(albumPeak), 'loudness'])
  }
  return out
}

/** Fields the categories may empty on purpose: an uploader's site as the album ('http://tunes4free.com',
 *  'FREE MP3s') or a placeholder genre ('Other', 'genre'). An album artist goes only along with its album. */
const CLEARABLE: Field[] = ['album', 'albumartist', 'genre']

/** What apply would write: every field whose target differs from the disk. An empty target is a field to clear only
 *  in CLEARABLE, where the categories rejected what is there; everywhere else it is left alone, so a proposal adds
 *  and corrects but does not erase what nobody replaced. */
export function propose(inv: Inventory, c: Categories, e?: Enrichment): Proposal {
  const fileOf = new Map(inv.folders.flatMap((f) => f.files.map((file) => [relPath(inv.roots, file.path), file] as const)))
  const albumOf = new Map(c.albums.flatMap((a) => a.tracks.map((p) => [p, a] as const)))
  const files: FilePlan[] = []
  for (const t of c.tracks) {
    const f = fileOf.get(t.path)
    if (!f) continue
    const album = albumOf.get(t.path)
    const members = album ? c.tracks.filter((x) => album.tracks.includes(x.path)) : []
    const albumPeak = members.length && members.every((x) => x.loudness) ? Math.max(...members.map((x) => x.loudness?.peak ?? 0)) : undefined
    const all = targets(t, e, album?.lufs, albumPeak)
    const clears = (field: Field) => CLEARABLE.includes(field) && (field !== 'albumartist' || !t.album)
    const changes = all
      // exact, so a casing fix ('too late' -> 'Too Late') is proposed
      .filter(([field, to]) => (to !== '' || clears(field)) && to !== onDisk(f, field).trim())
      .map(([field, to, source]) => ({ field, from: onDisk(f, field), to, source }))
    const plan: FilePlan = { path: t.path, changes }
    // a file that already carries a picture or lyrics keeps them
    const cover = album?.cover ?? t.cover
    if (cover && !f.pictures.length) plan.cover = cover
    if ((t.lyrics === 'synced' || t.lyrics === 'plain') && f.extra.lyrics === undefined) plan.lyrics = t.lyrics
    files.push(plan)
  }
  const byField: Record<string, number> = {}
  const bySource: Record<string, number> = {}
  for (const p of files) for (const ch of p.changes) {
    byField[ch.field] = (byField[ch.field] ?? 0) + 1
    bySource[ch.source] = (bySource[ch.source] ?? 0) + 1
  }
  return {
    version: PROPOSAL_VERSION,
    summary: {
      files: files.length,
      changed: files.filter((p) => p.changes.length).length,
      byField,
      bySource,
      covers: files.filter((p) => p.cover).length,
      lyrics: files.filter((p) => p.lyrics).length,
    },
    files,
  }
}

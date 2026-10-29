/** Where each file goes when apply organizes a copy of the library instead of keeping its folders: one folder per
 *  album artist and album, compilations and DJ mixes apart, loose tracks together, and what nobody could name in a
 *  review folder. Pure: the same categories give the same paths. */
import { basename, extname } from 'node:path'
import type { Album, Categories, FolderKind, Track } from './categories.ts'
import { known, nfc } from './text.ts'

export type Layout = 'keep' | 'organize'
export const LAYOUTS: Layout[] = ['keep', 'organize']

export const NEEDS_REVIEW = '_Needs review'
export const SINGLES = 'Singles'
export const COMPILATIONS = 'Compilations'
export const DJ_MIXES = 'DJ Mixes'

/** Longest path segment kept, under the 255 bytes most file systems allow with room for a collision suffix. */
const SEGMENT = 120

/** A name that is safe as one path segment on macOS, Linux and Windows. */
export function segment(s: string): string {
  const safe = nfc(s)
    // 'Night Shift: The Collection' reads as 'Night Shift - The Collection', not 'Night Shift- The Collection'
    .replace(/\s*:\s+/g, ' - ')
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
  return safe.slice(0, SEGMENT).trim() || '_'
}

const number = (t: Track, discs: number) => {
  const n = t.track ? String(t.track).padStart(2, '0') : ''
  if (!n) return ''
  return discs > 1 && t.disc ? `${t.disc}-${n} - ` : `${n} - `
}

/** The year most of the album's tracks carry, the earliest on a tie. */
function albumYear(album: Album, tracks: Map<string, Track>): number | undefined {
  const counts = new Map<number, number>()
  for (const p of album.tracks) {
    const y = tracks.get(p)?.year
    if (y) counts.set(y, (counts.get(y) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0]
}

/** The organized path of one track, relative to the new root, keeping the file's extension. */
function place(t: Track, album: Album | undefined, kind: FolderKind | undefined, tracks: Map<string, Track>): string {
  const ext = extname(t.path).toLowerCase()
  if (!known(t.title) || !known(t.artist)) return `${NEEDS_REVIEW}/${segment(basename(t.path, extname(t.path)))}${ext}`
  if (kind === 'loose' || !album) return `${SINGLES}/${segment(`${t.artist} - ${t.title}`)}${ext}`
  const y = albumYear(album, tracks)
  const name = segment(`${album.name}${y ? ` (${y})` : ''}`)
  const discs = new Set(album.tracks.map((p) => tracks.get(p)?.disc ?? 1)).size
  const n = number(t, discs)
  if (kind === 'compilation') return `${COMPILATIONS}/${name}/${n}${segment(`${t.artist} - ${t.title}`)}${ext}`
  if (kind === 'dj-mix') return `${DJ_MIXES}/${segment(`${album.albumartist} - ${name}`)}/${n}${segment(`${t.artist} - ${t.title}`)}${ext}`
  return `${segment(album.albumartist)}/${name}/${n}${segment(t.title)}${ext}`
}

/** Track path -> organized path for every track. Two tracks that would land on one path keep both, the later
 *  ones numbered (2), (3); case is ignored when comparing, as on macOS and Windows. */
export function organize(c: Categories): Map<string, string> {
  const tracks = new Map(c.tracks.map((t) => [t.path, t]))
  const albumOf = new Map(c.albums.flatMap((a) => a.tracks.map((p) => [p, a] as const)))
  const kindOf = new Map(c.folders.map((f) => [f.path, f.kind]))
  const taken = new Set<string>()
  const out = new Map<string, string>()
  for (const t of [...c.tracks].sort((a, b) => a.path.localeCompare(b.path))) {
    const want = place(t, albumOf.get(t.path), kindOf.get(t.folder), tracks)
    const ext = extname(want)
    let to = want
    for (let i = 2; taken.has(to.toLowerCase()); i++) to = `${want.slice(0, -ext.length || undefined)} (${i})${ext}`
    taken.add(to.toLowerCase())
    out.set(t.path, to)
  }
  return out
}

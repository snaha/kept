/** Scores categories against an answer key a person wrote for a test library: what each folder is, what the
 *  tricky tracks are really called, which tracks are one song. The key names only what a person is sure of, so
 *  every failed check is either a bug or a job for a later stage (identify, covers). */
import type { Categories, Credit, FolderKind, Version } from './categories.ts'
import { norm } from './text.ts'

export type AnswerKey = {
  /** folder path relative to the root -> what it is; album and album artist only where they are certain */
  folders?: Record<string, { kind?: FolderKind; album?: string; albumartist?: string; note?: string }>
  /** track path relative to the root -> the values it should end up with */
  tracks?: Record<string, { title?: string; artist?: string; album?: string; year?: number; version?: Version; credits?: Credit[]; note?: string }>
  /** sets of track paths that are versions of one song */
  songs?: string[][]
  /** folder path -> words each of which some album issue of that folder must contain */
  albumIssues?: Record<string, string[]>
}

export type Check = { what: string; pass: boolean; expected: string; actual: string }

const same = (a: string | undefined, b: string | undefined): boolean => norm(a).replace(/ /g, '') === norm(b).replace(/ /g, '')

export function score(c: Categories, key: AnswerKey): Check[] {
  const checks: Check[] = []
  const check = (what: string, expected: string, actual: string, pass = same(expected, actual)) => checks.push({ what, pass, expected, actual })

  for (const [path, want] of Object.entries(key.folders ?? {})) {
    const folder = c.folders.find((f) => f.path === path)
    // the folder's own album: the one holding most of its files, not a single's remix filed beside it
    const album = c.albums.filter((a) => a.folder === path).sort((a, b) => b.tracks.length - a.tracks.length)[0]
    if (want.kind) check(`${path}: kind`, want.kind, folder?.kind ?? 'missing')
    if (want.album) check(`${path}: album`, want.album, album?.name ?? 'none')
    if (want.albumartist) check(`${path}: album artist`, want.albumartist, album?.albumartist ?? 'none')
  }
  for (const [path, want] of Object.entries(key.tracks ?? {})) {
    const t = c.tracks.find((x) => x.path === path)
    if (want.title) check(`${path}: title`, want.title, t?.title ?? 'missing')
    if (want.artist) check(`${path}: artist`, want.artist, t?.artist ?? 'missing')
    if (want.album) check(`${path}: album`, want.album, t?.album ?? 'missing')
    if (want.year) check(`${path}: year`, String(want.year), String(t?.year ?? 'none'))
    if (want.version) check(`${path}: version`, want.version, t?.version ?? 'missing')
    for (const credit of want.credits ?? []) {
      const found = t?.credits.some((x) => x.role === credit.role && same(x.name, credit.name)) ?? false
      check(`${path}: credit`, `${credit.role} ${credit.name}`, t ? t.credits.map((x) => `${x.role} ${x.name}`).join(', ') : 'missing', found)
    }
  }
  for (const set of key.songs ?? []) {
    const songs = new Set(set.map((p) => c.tracks.find((t) => t.path === p)?.song ?? `missing ${p}`))
    check(`one song: ${set.join(' + ')}`, 'one song key', [...songs].join(', '), songs.size === 1 && !set.some((p) => !c.tracks.some((t) => t.path === p)))
  }
  for (const [path, words] of Object.entries(key.albumIssues ?? {})) {
    const issues = c.albums.filter((a) => a.folder === path).flatMap((a) => a.issues)
    for (const w of words) check(`${path}: album issue`, w, issues.join('; ') || 'none', issues.some((i) => i.includes(w)))
  }
  return checks
}

export function formatScore(checks: Check[], all = false): string {
  const passed = checks.filter((c) => c.pass).length
  const lines = checks.filter((c) => all || !c.pass).map((c) => `  ${c.pass ? 'pass' : 'FAIL'} ${c.what}: expected ${c.expected}, got ${c.actual}`)
  return [`${passed}/${checks.length} checks pass`, ...lines].join('\n')
}

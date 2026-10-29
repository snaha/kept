/** Stage 4: the proposal, written to a copy of the library. Every audio file is cloned to a new folder, outside
 *  every scanned root, and only the clone is tagged, so the library itself is never opened for writing. Each
 *  written file is read back and compared with the proposal, so the result says what really landed on disk. Album
 *  folders get a cover.jpg and the copy a few playlists made from the categories, which Navidrome imports. */
import { constants } from 'node:fs'
import { chmod, copyFile, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { audioDigest } from './audio-digest.ts'
import { relPath, type Categories, type Group } from './categories.ts'
import type { Inventory } from './inventory.ts'
import { organize, segment, type Layout } from './layout.ts'
import { onDisk, type Field, type Proposal } from './proposal.ts'
import { readTags, type TagReader } from './tags.ts'
import { writeTags, type TagWriter } from './write.ts'

export const APPLY_VERSION = 1
/** Left in every copy apply makes; only a folder holding it is ever emptied by a later apply. */
export const MARKER = '.tagsmith-apply'
export const PLAYLISTS = 'Playlists'
const FILE_MODE = 0o644
const MPEG = /\.mp3$/i

export type AppliedFile = {
  /** relative to the scanned root */
  from: string
  /** relative to the copy */
  to: string
  written: Field[]
  cover: boolean
  lyrics: boolean
  /** fields that read back different from what was written */
  mismatches: { field: Field | 'cover'; want: string; got: string }[]
  /** whether the copy's audio bytes equal the original's (MP3 only: the bytes between its tags) */
  audio?: 'same' | 'changed'
  error?: string
}

export type Applied = {
  version: number
  to: string
  layout: Layout
  summary: { files: number; tagged: number; fields: number; covers: number; lyrics: number; folderCovers: number; playlists: number; mismatches: number; audioChanged: number; errors: number }
  files: AppliedFile[]
  /** cover.jpg files written, relative to the copy */
  folderCovers: string[]
  playlists: string[]
}

export type ApplyOptions = {
  to: string
  layout?: Layout
  write?: TagWriter
  read?: TagReader
  /** the JPEG front of a MusicBrainz release, when enrich downloaded it */
  cover?: (release: string) => Promise<Buffer | undefined>
  /** lyrics text for a track path, when LRCLIB had it */
  lyrics?: (path: string) => Promise<string | undefined>
  onProgress?: (done: number, total: number) => void
}

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)

/** The copy goes to a new or empty folder, or over an earlier copy of apply's; never into or around a scanned root. */
async function prepare(to: string, roots: string[]): Promise<void> {
  // compared as real paths, so a symlink cannot lead the copy back into the library
  const real = async (p: string): Promise<string> => realpath(p).catch(async () => join(await real(dirname(p)), basename(p)))
  const target = await real(to)
  for (const root of await Promise.all(roots.map((r) => real(resolve(r)))))
    if (inside(target, root) || inside(root, target)) throw new Error(`apply writes a copy: ${to} must be outside the scanned library ${root}`)
  const entries = await readdir(to).catch((e: NodeJS.ErrnoException): string[] => {
    if (e.code === 'ENOENT') return []
    throw e
  })
  if (entries.length && !entries.includes(MARKER)) throw new Error(`${to} is not empty and was not made by apply; choose a new folder`)
  if (entries.length) await rm(to, { recursive: true })
  await mkdir(to, { recursive: true })
  await writeFile(join(to, MARKER), 'written by tagsmith apply; the next apply to this folder replaces everything in it\n')
}

/** One .m3u8 per useful group, paths relative to the playlist; Navidrome imports playlists it finds in the library. */
function playlists(c: Categories, target: Map<string, string>): [string, string[]][] {
  const named = (name: string, ...groups: (Group | undefined)[]): [string, string[]] => [name, groups.flatMap((g) => g?.tracks ?? [])]
  const lists: [string, string[]][] = [
    named('Remixes and mixes', ...c.versions.filter((g) => g.key === 'remix' || g.key === 'megamix')),
    named('Songs in several versions', ...c.songs),
    ...c.decades.filter((g) => g.key !== 'unknown').map((g) => named(`The ${g.name}`, g)),
    named('Needs review', ...c.identified.filter((g) => g.key === 'not identified')),
  ]
  return lists
    .map(([name, paths]): [string, string[]] => [name, paths.map((p) => target.get(p)).filter((p): p is string => !!p)])
    .filter(([, paths]) => paths.length > 1)
}

export async function apply(inv: Inventory, c: Categories, proposal: Proposal, opts: ApplyOptions): Promise<Applied> {
  const to = resolve(opts.to)
  const layout = opts.layout ?? 'keep'
  const write = opts.write ?? writeTags
  const read = opts.read ?? readTags
  await prepare(to, inv.roots)

  const source = new Map(inv.folders.flatMap((f) => f.files.map((file) => [relPath(inv.roots, file.path), file.path] as const)))
  const target = layout === 'organize' ? organize(c) : new Map(c.tracks.map((t) => [t.path, t.path]))
  const albumOf = new Map(c.albums.flatMap((a) => a.tracks.map((p) => [p, a] as const)))
  const trackOf = new Map(c.tracks.map((t) => [t.path, t]))
  const files: AppliedFile[] = []
  let done = 0

  for (const plan of proposal.files) {
    const from = source.get(plan.path)
    const rel = target.get(plan.path) ?? plan.path
    const out: AppliedFile = { from: plan.path, to: rel, written: [], cover: false, lyrics: false, mismatches: [] }
    files.push(out)
    opts.onProgress?.(++done, proposal.files.length)
    if (!from) {
      out.error = 'not in the inventory'
      continue
    }
    const dest = join(to, rel)
    try {
      await mkdir(dirname(dest), { recursive: true })
      // a clone on APFS and btrfs costs no space; elsewhere a plain copy
      await copyFile(from, dest, constants.COPYFILE_FICLONE)
      await chmod(dest, FILE_MODE)
      const release = trackOf.get(plan.path)?.release
      const cover = plan.cover && release ? await opts.cover?.(release) : undefined
      const lyrics = plan.lyrics ? await opts.lyrics?.(plan.path) : undefined
      const set = Object.fromEntries(plan.changes.map((ch) => [ch.field, ch.to]))
      if (plan.changes.length || cover || lyrics) await write(dest, { set, cover, lyrics })
      out.written = plan.changes.map((ch) => ch.field)
      out.cover = !!cover
      out.lyrics = !!lyrics
      // read back what landed: a writer that drops or mangles a field shows here, not in Navidrome weeks later
      const back = await read(dest)
      for (const ch of plan.changes) {
        const got = onDisk(back, ch.field).trim()
        if (got !== ch.to) out.mismatches.push({ field: ch.field, want: ch.to, got })
      }
      if (cover && !back.pictures.length) out.mismatches.push({ field: 'cover', want: 'embedded', got: 'none' })
      if (MPEG.test(from)) out.audio = (await audioDigest(from)) === (await audioDigest(dest)) ? 'same' : 'changed'
    } catch (e) {
      out.error = (e as Error).message
    }
  }

  // cover.jpg where a folder of the copy holds one album with a cover and nothing else
  const byDir = new Map<string, Set<string>>()
  for (const f of files) {
    const dir = dirname(f.to)
    const album = albumOf.get(f.from)
    byDir.set(dir, (byDir.get(dir) ?? new Set()).add(album?.cover ? `${album.key}\u0000${album.release}` : ''))
  }
  const folderCovers: string[] = []
  for (const [dir, albums] of [...byDir].sort(([a], [b]) => a.localeCompare(b))) {
    const [only] = [...albums]
    const release = albums.size === 1 && only ? only.split('\u0000')[1] : undefined
    const bytes = release ? await opts.cover?.(release) : undefined
    if (!bytes) continue
    const file = join(dir, 'cover.jpg')
    await writeFile(join(to, file), bytes)
    folderCovers.push(file)
  }

  const written: string[] = []
  for (const [name, paths] of playlists(c, target)) {
    const file = join(PLAYLISTS, `${segment(name)}.m3u8`)
    await mkdir(join(to, PLAYLISTS), { recursive: true })
    await writeFile(join(to, file), ['#EXTM3U', `#PLAYLIST:${name}`, ...paths.map((p) => relative(PLAYLISTS, p))].join('\n') + '\n')
    written.push(file)
  }

  return {
    version: APPLY_VERSION,
    to,
    layout,
    summary: {
      files: files.length,
      tagged: files.filter((f) => f.written.length).length,
      fields: files.reduce((n, f) => n + f.written.length, 0),
      covers: files.filter((f) => f.cover).length,
      lyrics: files.filter((f) => f.lyrics).length,
      folderCovers: folderCovers.length,
      playlists: written.length,
      mismatches: files.reduce((n, f) => n + f.mismatches.length, 0),
      audioChanged: files.filter((f) => f.audio === 'changed').length,
      errors: files.filter((f) => f.error).length,
    },
    files,
    folderCovers,
    playlists: written,
  }
}

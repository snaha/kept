import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { musicFolderLinkName } from './music-folders.js'

// Maps a Navidrome song to its real file. With ND_SUBSONIC_DEFAULTREPORTREALPATH=true the
// API reports the scanned path: absolute, under the combined root of folder symlinks that
// prepareMusicRoot builds (or directly under the folder when there is a single one).
// Without the flag it reports a tag-derived "Artist/Album/File" path that is not on disk,
// so only the normalised relative join can use it, and only when the layouts agree.

export const RESOLVED_BY = Object.freeze({ reported: 'reported', relative: 'relative', unresolved: 'unresolved' })

const LINK_NAME = /^folder-[a-f\d]{16}$/
const isInside = (parent, child) => {
  const relative = path.relative(parent, child)
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
const toKey = relative => relative.split(/[\\/]+/).filter(Boolean).join('/').normalize('NFC').toLowerCase()
const isFile = file => { try { return statSync(file).isFile() } catch { return false } }
const real = file => { try { return realpathSync(file) } catch { return undefined } }

function walk(directory, relative, visit, seen) {
  const key = real(directory)
  if (!key || seen.has(key)) return
  seen.add(key)
  let entries
  try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const file = path.join(directory, entry.name)
    const next = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) walk(file, next, visit, seen)
    else if (entry.isFile()) visit(file, next)
    else if (entry.isSymbolicLink()) {
      let stat
      try { stat = statSync(file) } catch { continue }
      if (stat.isDirectory()) walk(file, next, visit, seen)
      else if (stat.isFile()) visit(file, next)
    }
  }
}

// root: the directory Navidrome scans (ND_MUSICFOLDER). folders: the real music folders.
export function createTrackPathResolver({ root, folders, combined = folders.length > 1 }) {
  const links = new Map(folders.map(folder => [musicFolderLinkName(folder), folder]))
  const roots = [root, real(root)].filter(Boolean)
  let index

  // Lazily indexes every file by its normalised path relative to a folder, and without the
  // folder name. A key with two files is ambiguous and never resolves.
  const buildIndex = () => {
    if (index) return index
    index = new Map()
    for (const folder of folders) {
      walk(folder, '', (file, relative) => {
        for (const key of [toKey(relative), toKey(`${path.basename(folder)}/${relative}`)]) {
          const known = index.get(key)
          if (known === undefined) index.set(key, file)
          else if (known !== file) index.set(key, '')
        }
      }, new Set())
    }
    return index
  }

  const fromReported = reported => {
    if (!path.isAbsolute(reported)) return undefined
    for (const base of roots) {
      if (!isInside(base, reported)) continue
      const [first, ...rest] = path.relative(base, reported).split(path.sep)
      const folder = combined ? links.get(first) : folders[0]
      if (!folder) continue
      const file = path.join(folder, ...(combined ? rest : [first, ...rest]))
      if (isFile(file)) return real(file)
    }
    // A direct path into a music folder (a single, uncombined root).
    const direct = folders.find(folder => isInside(folder, reported))
    if (direct && isFile(reported)) return real(reported)
    return undefined
  }

  const fromRelative = reported => {
    let relative = reported
    if (path.isAbsolute(reported)) {
      const base = roots.find(candidate => isInside(candidate, reported))
      if (!base) return undefined
      relative = path.relative(base, reported)
      const [first, ...rest] = relative.split(path.sep)
      if (LINK_NAME.test(first)) relative = rest.join('/')
    }
    const file = buildIndex().get(toKey(relative))
    return file ? real(file) : undefined
  }

  return {
    // song: { id, path } as returned by getSong, getAlbum or search3.
    resolve(song) {
      const reported = typeof song.path === 'string' ? song.path : ''
      if (reported) {
        const exact = fromReported(reported)
        if (exact) return { id: song.id, file: exact, by: RESOLVED_BY.reported }
        const joined = fromRelative(reported)
        if (joined) return { id: song.id, file: joined, by: RESOLVED_BY.relative }
      }
      return { id: song.id, file: undefined, by: RESOLVED_BY.unresolved }
    },
    // Player and history records made before the flag hold only a song ID. The server
    // now reports the real path for that ID, so one getSong call resolves it.
    async resolveId(id, getSong) {
      const song = await getSong(id)
      return this.resolve({ id, path: song?.path })
    },
  }
}


import { createHash, randomBytes } from 'node:crypto'
import { readdirSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { NAVIDROME_SOURCE_ID } from '../shared/catalog-bridge.js'
import { MAX_TAG_LENGTH } from '../shared/catalog-projection.js'
import { musicFolderLinkName } from './music-folders.js'
import { audioFileVersion } from './audio-payload.js'

// Feeds the identity spine from what Navidrome scanned. Each music folder is a source, and
// Navidrome is the provider whose album and song IDs are linked to anchors and assets.
// Hashing is the slow part: unchanged file versions are not read again, and whole albums
// are ingested as they finish.

export const NAVIDROME_SOURCE = Object.freeze({
  id: NAVIDROME_SOURCE_ID, kind: 'navidrome', label: 'Navidrome', evidenceClass: 'deterministic', licence: 'user',
  policy: { analysisAllowed: true, network: 'lan' },
})
export const folderSourceId = folder => musicFolderLinkName(folder)
export const folderSource = folder => ({
  id: folderSourceId(folder), kind: 'local-folder', label: path.basename(folder) || 'Music', evidenceClass: 'deterministic', licence: 'user',
  policy: { analysisAllowed: true, network: 'none' },
})

export const INGEST_BATCH_ALBUMS = 25
export const SYNC_POLL_MS = 5000
const SONG_PAGE = 500
const SALT_BYTES = 8
const SUBSONIC_VERSION = '1.16.1'
const SUBSONIC_CLIENT = 'kept'

const isDirectory = folder => { try { return statSync(folder).isDirectory() } catch { return false } }
const isEmptyDirectory = folder => { try { return !readdirSync(folder).length } catch { return true } }
const realOf = folder => { try { return realpathSync(folder) } catch { return folder } }
const isCount = value => Number.isSafeInteger(value) && value >= 0

async function subsonic({ base, username, password, fetch = globalThis.fetch }, endpoint, parameters, signal) {
  const salt = randomBytes(SALT_BYTES).toString('hex')
  const token = createHash('md5').update(password + salt).digest('hex')
  const query = new URLSearchParams({ u: username, t: token, s: salt, v: SUBSONIC_VERSION, c: SUBSONIC_CLIENT, f: 'json', ...parameters })
  const response = await fetch(`${base}/rest/${endpoint}?${query}`, { signal })
  if (!response.ok) throw new Error(`The music server answered ${response.status}`)
  const body = (await response.json())['subsonic-response']
  if (body?.status !== 'ok') throw new Error(body?.error?.message ?? 'The music server refused the request')
  return body
}

export const fetchScanStatus = async (connection, signal) => (await subsonic(connection, 'getScanStatus', {}, signal)).scanStatus ?? {}
// Before its first scan Navidrome reports the year 1 and no songs. Ingesting that would mark a known library as missing.
export const hasScanned = status => !status.scanning && Date.parse(status.lastScan) > 0

// The tags Navidrome read from the file. They become observations of the folder the file is in.
const tagText = value => (typeof value === 'string' && value.length > 0 && value.length <= MAX_TAG_LENGTH ? value : undefined)
export const songTags = song => ({
  title: tagText(song.title), artist: tagText(song.artist), album: tagText(song.album), albumArtist: tagText(song.displayAlbumArtist),
  year: Number.isSafeInteger(song.year) && song.year > 0 ? song.year : undefined, genre: tagText(song.genre),
})

// Every song Navidrome knows, with the album it files it under and its reported path.
export async function fetchLibrarySongs(connection, signal) {
  const songs = []
  for (let offset = 0; ; offset += SONG_PAGE) {
    const body = await subsonic(connection, 'search3', { query: '""', songCount: SONG_PAGE, songOffset: offset, albumCount: 0, artistCount: 0 }, signal)
    const page = body.searchResult3?.song ?? []
    for (const song of page) songs.push({ id: song.id, albumId: song.albumId, path: song.path, duration: song.duration, track: song.track, disc: song.discNumber, tags: songTags(song) })
    if (page.length < SONG_PAGE) return songs
  }
}

// Marks every location of a folder source that is not online as unavailable. Nothing is deleted:
// the anchors, traits and favourites of an unplugged drive wait for it to come back.
export async function markUnavailableSources({ catalog, folders, now = Date.now }) {
  const online = new Set(folders.filter(isDirectory).map(folderSourceId))
  const { sources } = await catalog.listSources()
  const offline = sources.filter(source => source.kind === 'local-folder' && !online.has(source.id))
  for (const source of offline) await catalog.ingestScan({ sourceId: source.id, observedAt: now(), rootAvailable: false, complete: false, files: [] })
  return offline.map(source => source.id)
}

// catalog: the CatalogService plus fileHashes and storeFileHashes. songs: from fetchLibrarySongs.
// resolveFile: song -> the real file, or undefined.
// hashFile: (file, signal, versioned location) -> { contentHash, size }, or undefined if that version changed.
// prefetchHashes, when given, is told every file that must be hashed before the first one is asked for,
// as { sourceId, path, file, fileVersion }, so the job queue can work on them ahead of the loop below.
export async function ingestLibrary({ catalog, folders, songs, resolveFile, hashFile, prefetchHashes, now = Date.now, signal, onBatch, batchAlbums = INGEST_BATCH_ALBUMS }) {
  const startedAt = now()
  const stats = { songs: songs.length, unresolved: 0, hashed: 0, reused: 0, failed: 0, assets: 0, albums: 0, conflicts: [], unavailable: [], aborted: false, hashMs: 0 }
  const registered = new Set((await catalog.listSources()).sources.map(source => source.id))
  // Registered once: a later phase may change a source's policy, and a rescan must not reset it.
  const register = async source => { if (!registered.has(source.id)) await catalog.registerSource(source) }
  await register(NAVIDROME_SOURCE)
  const roots = []
  for (const folder of folders.filter(isDirectory)) {
    const source = folderSource(folder)
    await register(source)
    const { entries } = await catalog.fileHashes({ sourceId: source.id })
    roots.push({ folder, real: realOf(folder), sourceId: source.id, known: new Map(entries.map(entry => [entry.path, entry])), files: [], hashes: [], fresh: [], pending: [] })
  }
  stats.unavailable = await markUnavailableSources({ catalog, folders, now })

  const albums = new Map()
  for (const song of songs) {
    const file = resolveFile(song)
    const root = file && roots.find(candidate => file.startsWith(candidate.real + path.sep))
    if (!root) { stats.unresolved++; continue }
    const relative = path.relative(root.real, file).split(path.sep).join('/')
    const albumKey = song.albumId ?? ''
    albums.set(albumKey, [...albums.get(albumKey) ?? [], { song, file, root, relative }])
  }

  if (prefetchHashes) {
    const wanted = []
    for (const members of albums.values()) {
      for (const { file, root, relative } of members) {
        try {
          const { fileVersion } = await audioFileVersion(file)
          if (root.known.get(relative)?.fileVersion !== fileVersion) wanted.push({ sourceId: root.sourceId, path: relative, file, fileVersion })
        } catch { /* reported as failed by the loop below */ }
      }
    }
    if (!signal?.aborted) await prefetchHashes(wanted, signal)
  }

  const assetIds = new Set(), albumIds = new Set()
  const ingest = async (root, files, complete) => {
    const result = await catalog.ingestScan({ sourceId: root.sourceId, providerSourceId: NAVIDROME_SOURCE.id, observedAt: startedAt, rootAvailable: true, complete, files })
    for (const id of result.assetIds) assetIds.add(id)
    for (const id of result.albumIds) albumIds.add(id)
    return result
  }
  const flush = async () => {
    for (const root of roots) {
      if (root.pending.length) await ingest(root, root.pending, false)
      if (root.fresh.length) await catalog.storeFileHashes({ sourceId: root.sourceId, entries: root.fresh })
      root.pending = []
      root.fresh = []
    }
  }

  let albumsSinceFlush = 0, hashedSinceFlush = 0
  for (const members of albums.values()) {
    for (const { song, file, root, relative } of members) {
      if (signal?.aborted) break
      let entry
      try {
        let version = await audioFileVersion(file)
        const known = root.known.get(relative)
        if (known?.fileVersion === version.fileVersion) {
          entry = known
          stats.reused++
        } else {
          const hashStarted = performance.now()
          // A replacement can land while waiting for a prefetched job. Try the new version
          // once, leaving the scan incomplete if the file keeps changing.
          for (let attempt = 0; attempt < 2 && !signal?.aborted; attempt++) {
            const result = await hashFile(file, signal, { sourceId: root.sourceId, path: relative, fileVersion: version.fileVersion })
            const current = await audioFileVersion(file)
            if (result && current.fileVersion === version.fileVersion) {
              entry = { path: relative, ...version, contentHash: result.contentHash, size: result.size }
              break
            }
            version = current
          }
          stats.hashMs += performance.now() - hashStarted
          if (!entry) throw new Error('The file changed while hashing')
          root.fresh.push(entry)
          stats.hashed++
          hashedSinceFlush++
        }
      } catch {
        // An unreadable file is left out of this scan. It is hashed again on the next one.
        stats.failed++
        root.incomplete = true
        continue
      }
      const scanned = {
        path: relative, contentHash: entry.contentHash, size: entry.size, providerTrackId: song.id, providerAlbumId: song.albumId,
        duration: Number.isFinite(song.duration) && song.duration >= 0 ? song.duration : undefined,
        disc: isCount(song.disc) ? song.disc : undefined, track: isCount(song.track) ? song.track : undefined, tags: song.tags,
      }
      root.hashes.push(entry)
      root.files.push(scanned)
      root.pending.push(scanned)
    }
    if (signal?.aborted) break
    // Whole albums only: a provider re-ID is recognised by a scan that covers every member of an anchor.
    if (++albumsSinceFlush >= batchAlbums && hashedSinceFlush) {
      await flush()
      albumsSinceFlush = 0
      hashedSinceFlush = 0
      onBatch?.()
    }
  }
  if (signal?.aborted) {
    // Keep what was hashed. The half-read album is ingested by the next run.
    for (const root of roots) if (root.fresh.length) await catalog.storeFileHashes({ sourceId: root.sourceId, entries: root.fresh })
    return { ...stats, aborted: true, assets: assetIds.size, albums: albumIds.size, ms: now() - startedAt }
  }
  for (const root of roots) {
    // A mount point that is present but empty is an unplugged drive, not a deleted library.
    if (!root.files.length && root.known.size && isEmptyDirectory(root.folder)) {
      await catalog.ingestScan({ sourceId: root.sourceId, observedAt: startedAt, rootAvailable: false, complete: false, files: [] })
      stats.unavailable.push(root.sourceId)
      continue
    }
    // An unresolved song could belong to any root. Only prune once the scan accounts for every song.
    const complete = !root.incomplete && stats.unresolved === 0
    const { conflicts } = await ingest(root, root.files, complete)
    stats.conflicts.push(...conflicts)
    await catalog.storeFileHashes({ sourceId: root.sourceId, entries: root.hashes, prune: complete })
  }
  return { ...stats, assets: assetIds.size, albums: albumIds.size, ms: now() - startedAt }
}

// Watches Navidrome's scan status and ingests after every finished scan. stop() aborts the
// run in flight and resolves once nothing more will touch the catalog.
export function startCatalogSync({ connection, catalog, folders, resolveFile, hashFile, prefetchHashes, onChange, onError, pollMs = SYNC_POLL_MS }) {
  const controller = new AbortController()
  const { signal } = controller
  let timer, ingested, lastError = '', running = Promise.resolve()
  const tick = async () => {
    try {
      const status = await fetchScanStatus(connection, signal)
      const key = `${status.lastScan ?? ''}:${status.count ?? 0}`
      if (hasScanned(status) && key !== ingested) {
        const songs = await fetchLibrarySongs(connection, signal)
        const result = await ingestLibrary({ catalog, folders, songs, resolveFile, hashFile, prefetchHashes, signal, onBatch: () => onChange?.() })
        if (!result.aborted) {
          ingested = key
          onChange?.(result)
        }
      }
      lastError = ''
    } catch (error) {
      if (!signal.aborted && error.message !== lastError) onError?.(error)
      lastError = error.message
    }
    if (!signal.aborted) timer = setTimeout(() => { running = tick() }, pollMs)
  }
  running = tick()
  return {
    stop() {
      controller.abort()
      clearTimeout(timer)
      return running
    },
  }
}

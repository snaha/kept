// End-to-end check of the identity spine on a real folder, which is only ever read:
//   node scripts/catalog-e2e.mjs <music folder> [work folder]
// Runs the bundled Navidrome on a temporary data folder, ingests its scan into a temporary
// library.sqlite, scans again, then rebuilds Navidrome's database and renames every
// provider ID to prove that tags survive a re-ID. Then times the read model and the ledger:
// a full projection rebuild, a list, a search, and a commit with its undo. Prints the counts
// and times as JSON.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createCatalogBridge } from '../../shared/catalog-bridge.js'
import { CatalogDatabase } from '../catalog-database.js'
import { fetchLibrarySongs, fetchScanStatus, hasScanned, ingestLibrary } from '../catalog-ingest.js'
import { createLibraryService } from '../library-service.js'
import { nodeFork } from '../library-process.js'
import { createTrackPathResolver } from '../track-paths.js'

const POLL_MS = 500
const START_TRIES = 240
const PASSWORD_BYTES = 18
const ENERGY = 73
const OTHER_ENERGY = 12
const TENTHS = 10
const SEARCH_QUERY = 'the'
const LIST_PAGE = 500
const [musicArgument, workArgument] = process.argv.slice(2)
if (!musicArgument) throw new Error('Usage: node scripts/catalog-e2e.mjs <music folder> [work folder]')
const music = realpathSync(musicArgument)
const base = workArgument ?? os.tmpdir()
mkdirSync(base, { recursive: true })
const work = mkdtempSync(path.join(base, 'kept-catalog-e2e-'))
const binary = fileURLToPath(new URL('../bin/navidrome', import.meta.url))
const freePort = () => new Promise(resolve => {
  const server = createServer()
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) })
})

async function scanWith(dataName) {
  const dataDir = path.join(work, dataName), port = await freePort(), password = randomBytes(PASSWORD_BYTES).toString('base64url')
  mkdirSync(dataDir, { recursive: true })
  const started = performance.now()
  const child = spawn(binary, [], {
    stdio: 'ignore',
    env: { ...process.env, ND_ADDRESS: '127.0.0.1', ND_PORT: String(port), ND_DATAFOLDER: dataDir, ND_CACHEFOLDER: path.join(dataDir, 'cache'), ND_MUSICFOLDER: music,
      ND_DEVAUTOCREATEADMINPASSWORD: password, ND_ENABLEINSIGHTSCOLLECTOR: 'false', ND_SCANNER_SCHEDULE: '0', ND_SCANNER_FOLLOWSYMLINKS: 'true',
      ND_SUBSONIC_DEFAULTREPORTREALPATH: 'true', ND_LOGLEVEL: 'error' },
  })
  const connection = { base: `http://127.0.0.1:${port}`, username: 'admin', password }
  try {
    for (let tries = 0; ; tries++) {
      try {
        if (hasScanned(await fetchScanStatus(connection))) break
      } catch (error) { if (tries >= START_TRIES || child.exitCode !== null) throw error }
      await sleep(POLL_MS)
    }
    const songs = await fetchLibrarySongs(connection)
    return { songs, scanMs: Math.round(performance.now() - started) }
  } finally { child.kill() }
}

const database = new CatalogDatabase(path.join(work, 'library.sqlite'))
const library = createLibraryService({ store: database.store, fork: nodeFork })
await library.start()
const bridge = createCatalogBridge(database.service)
const resolver = createTrackPathResolver({ root: music, folders: [music], combined: false })
const ingest = async songs => {
  const started = performance.now()
  const result = await ingestLibrary({ catalog: database.store, folders: [music], songs, resolveFile: song => resolver.resolve(song).file, prefetchHashes: library.hashJobs.prefetch, hashFile: library.hashJobs.hash })
  const { conflicts, ...counts } = result
  return { ...counts, conflicts: conflicts.length, hashMs: Math.round(result.hashMs), ms: Math.round(performance.now() - started) }
}
const tagged = async () => Object.values((await bridge.albums()).albums).filter(album => album.traits.energy?.value === ENERGY && album.favorite).length

try {
  const first = await scanWith('navidrome-1')
  const report = { music, songs: first.songs.length, navidromeScanMs: first.scanMs }
  report.firstIngest = await ingest(first.songs)
  report.rescan = await ingest(first.songs)
  const before = (await bridge.albums()).albums
  report.providerAlbums = Object.keys(before).length
  report.anchors = (await database.service.listAlbums({ limit: 1 })).total
  for (const providerAlbumId of Object.keys(before)) {
    await bridge.setTrait({ providerAlbumId, trait: 'energy', value: ENERGY })
    await bridge.setFavorite({ providerAlbumId, value: true })
  }
  report.taggedAnchors = new Set(Object.values((await bridge.albums()).albums).map(album => album.albumId)).size

  // A rebuilt Navidrome database, then every provider ID renamed as a full re-ID would.
  const second = await scanWith('navidrome-2')
  const firstIds = new Set(first.songs.map(song => song.id))
  report.rebuiltDatabase = { songs: second.songs.length, songIdsChanged: second.songs.filter(song => !firstIds.has(song.id)).length, ingest: await ingest(second.songs) }
  const renamed = second.songs.map(song => ({ ...song, id: `re-${song.id}`, albumId: `re-${song.albumId}` }))
  report.reId = { ingest: await ingest(renamed), anchors: (await database.service.listAlbums({ limit: 1 })).total }
  const after = (await bridge.albums()).albums
  const renamedAlbums = Object.keys(after).filter(id => id.startsWith('re-'))
  report.reId.providerAlbums = renamedAlbums.length
  report.reId.albumsKeepingTags = renamedAlbums.filter(id => after[id].traits.energy?.value === ENERGY && after[id].favorite && after[id].albumId === before[id.slice('re-'.length)]?.albumId).length
  report.reId.taggedAlbumsTotal = await tagged()

  // The read model and the ledger on the same library.
  const timed = async body => {
    const started = performance.now()
    const value = await body()
    return { value, ms: Math.round((performance.now() - started) * TENTHS) / TENTHS }
  }
  const { service } = database
  const rebuild = await timed(() => service.rebuildProjections())
  const check = await timed(() => service.verifyProjections())
  const list = await timed(() => service.listCatalogAlbums({ limit: LIST_PAGE }))
  const search = await timed(() => service.searchCatalog({ query: SEARCH_QUERY }))
  const [album] = list.value.albums
  const change = { id: 'change:e2e', author: { kind: 'user' }, operations: [{ kind: 'set-field', subject: { kind: 'album', id: album.id }, field: 'trait.energy', value: OTHER_ENERGY }], committedAt: Date.now() }
  const commit = await timed(() => service.commitChangeSet(change))
  const undo = await timed(() => service.undoChangeSet({ id: change.id, undoneAt: Date.now() }))
  report.projections = {
    albums: rebuild.value.albums, tracks: rebuild.value.tracks, titled: list.value.albums.filter(item => item.title).length, rebuildMs: rebuild.ms, verifyMs: check.ms,
    consistent: check.value.consistent, listMs: list.ms, searchMs: search.ms, searchHits: search.value.albums.length + search.value.tracks.length,
    commit: commit.value.status, commitMs: commit.ms, undo: undo.value.status, undoMs: undo.ms, consistentAfterUndo: (await service.verifyProjections()).consistent,
  }
  console.log(JSON.stringify(report, undefined, 2))
} finally {
  await library.stop()
  await database.close()
  rmSync(work, { recursive: true, force: true })
}

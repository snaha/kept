import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { CatalogStore } from '../catalog-store.js'
import { createEmbeddedReader } from '../embedded-tags.js'
import { cacheOf, createMusicBrainz } from '../musicbrainz.js'
import { catalogGroups, ingest, reconstructAll, scanFolder } from '../tests/reconstruct-corpus.js'

// Read-only dry run of the reconstruction ladder on a real folder, in a temporary catalog.
// Nothing is written to the folder, no tag is changed and no profile is touched.
//   node scripts/reconstruct-dry-run.mjs <folder> [--live]
// --live grants online lookups for at most LIVE_ALBUMS albums, one request per second, with the
// generic user agent of the MusicBrainz client. Without it nothing leaves the machine.

const LIVE_ALBUMS = 10
const SOURCE_ID = 'folder-dry-run'
const T0 = 1000
const [folder, flag] = process.argv.slice(2)
if (!folder) throw new Error('usage: reconstruct-dry-run.mjs <folder> [--live]')

const directory = mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'kept-dry-run-'))
const store = new CatalogStore(path.join(directory, 'catalog.sqlite'))
const tally = runs => {
  const counts = {}
  for (const { result } of runs) for (const outcome of result.outcomes) (counts[outcome.route] ??= {})[outcome.status] = (counts[outcome.route][outcome.status] ?? 0) + 1
  return counts
}
try {
  const scan = await scanFolder({ root: folder, sourceId: SOURCE_ID, observedAt: T0 })
  const pathOf = ingest(store, scan)
  const before = catalogGroups(store, pathOf)
  const reader = await createEmbeddedReader()
  const embedded = track => (reader ? reader(path.join(folder, ...pathOf.get(track.assetId).split('/'))) : scan.embedded.get(pathOf.get(track.assetId)))
  const tools = extra => cluster => ({ readEmbedded: embedded, cachedProvider: createMusicBrainz({ cache: cacheOf(cluster.cache), offline: true }), ...extra(cluster) })
  const offline = await reconstructAll(store, { now: T0 + 1, tools: tools(cluster => ({ provider: createMusicBrainz({ cache: cacheOf(cluster.cache), offline: true }) })) })
  const afterOffline = catalogGroups(store, pathOf)
  console.log(JSON.stringify({ files: scan.snapshot.files.length, albumsBefore: before.length, albumsAfterOffline: afterOffline.length, offlineRoutes: tally(offline) }))
  if (flag === '--live') {
    store.setConsent({ consent: 'online-lookups', value: 'granted', decidedAt: T0 + 2 })
    const live = await reconstructAll(store, { now: T0 + 3, limit: LIVE_ALBUMS, tools: tools(cluster => ({ provider: createMusicBrainz({ cache: cacheOf(cluster.cache) }) })) })
    const attempts = store.reconstruct.reconstructionAttempts().attempts
    console.log(JSON.stringify({ liveAlbums: live.length, albumsAfterLive: catalogGroups(store, pathOf).length, liveRoutes: tally(live) }))
    console.log(JSON.stringify({ attemptStatus: attempts.reduce((counts, attempt) => ({ ...counts, [attempt.status]: (counts[attempt.status] ?? 0) + 1 }), {}) }))
  } else {
    const attempts = store.reconstruct.reconstructionAttempts().attempts
    console.log(JSON.stringify({ attemptStatus: attempts.reduce((counts, attempt) => ({ ...counts, [attempt.status]: (counts[attempt.status] ?? 0) + 1 }), {}) }))
  }
} finally {
  store.close()
  rmSync(directory, { recursive: true, force: true })
}

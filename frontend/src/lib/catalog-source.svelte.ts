import type { SubsonicAPI } from 'subsonic-api'
import { coverUrl, session } from './api.svelte'
import { MAX_PLAYBACK_LINKS, NAVIDROME_SOURCE_ID, type CatalogBridge } from './catalog'
import type { CatalogSearchPage, CatalogSearchRequest } from './catalog-provider'
import { lanCatalog, openLanCatalog } from './lan-catalog'
import { localCatalog } from './local-catalog'
import type { CatalogRef, Collection, Track } from './music'
import { playbackResolver, trackCatalogRef, type PlaybackRef } from './playback-ref'
import { readPreference, writePreference } from './preferences'
import { createVirtualCatalog, isVirtualCollection, virtualTrackId } from './virtual-catalog'

/**
 * Which catalog the window browses. The desktop library's own catalog (albums as Kept
 * identified them, with repairs and undo) is used when its bridge is there and it is ready.
 * The music server's catalog serves in a browser, on a phone, while the library is still
 * being read for the first time, and when the bridge fails. Playlists always come from the
 * music server.
 */
export type CatalogKind = 'virtual' | 'navidrome'
// Why the music server's catalog is in use. Empty while the library's own catalog is.
export type CatalogFallback = '' | 'off' | 'unavailable' | 'empty' | 'catching-up' | 'failed'
const PREFERENCE = 'library.catalog'
const OFF = 'navidrome'
const LAN_FALLBACK_MS = 300
// The job class that reads each file once. While it has work, the library's catalog is still filling up.
const INGEST_JOB_CLASS = 'hash'
export const catalogSource = $state({ enabled: readPreference(PREFERENCE) !== OFF, active: 'navidrome' as CatalogKind, fallback: 'unavailable' as CatalogFallback })

const virtual = createVirtualCatalog({ resolver: playbackResolver, playbackSourceId: NAVIDROME_SOURCE_ID, cover: coverUrl })
// An older desktop build has the bridge without the read model. A LAN page uses the read-only client once it is signed in.
const bridge = (): Pick<CatalogBridge, 'catalogAlbums' | 'catalogAlbum' | 'catalogSearch' | 'playbackLinks'> | undefined => (typeof window.musicCatalog?.catalogAlbums === 'function' ? window.musicCatalog : lanCatalog())
const use = (active: CatalogKind, fallback: CatalogFallback) => { catalogSource.active = active; catalogSource.fallback = fallback }
let selectedAccount: SubsonicAPI | undefined
export function resetCatalogChoice() {
  selectedAccount = undefined
  use('navidrome', 'unavailable')
}

type Choice = [CatalogKind, CatalogFallback]
async function probe(client: ReturnType<typeof bridge>): Promise<Choice> {
  if (!client) return ['navidrome', 'unavailable']
  try {
    const [page, jobs] = await Promise.all([client.catalogAlbums({ limit: 1 }), window.musicJobs?.status()])
    if (!page.total) return ['navidrome', 'empty']
    const ingest = jobs?.classes[INGEST_JOB_CLASS]
    const reading = !!ingest && ingest.queued + ingest.running > 0
    return reading ? ['navidrome', 'catching-up'] : ['virtual', '']
  } catch { return ['navidrome', 'failed'] }
}

let lanReadiness: { api: SubsonicAPI; check: Promise<Choice> } | undefined
function checkLan(api: SubsonicAPI) {
  if (lanReadiness?.api === api) return lanReadiness.check
  const check = openLanCatalog().then(probe).then(choice => {
    if (choice[0] !== 'virtual' && lanReadiness?.check === check) lanReadiness = undefined
    return choice
  })
  lanReadiness = { api, check }
  return check
}

const usingDesktopCatalog = () => !!(window.desktop || window.musicCatalog)
const lanDeadline = () => performance.now() + LAN_FALLBACK_MS
async function withinLanDeadline<T>(deadline: number, read: () => Promise<T>): Promise<T> {
  const remaining = deadline - performance.now()
  const timeout = new Error('The library catalog did not answer in time.')
  if (remaining <= 0) throw timeout
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(timeout), remaining)
    })
    return await Promise.race([read(), expired])
  } finally { clearTimeout(timer) }
}

async function checkCatalog(api: SubsonicAPI, deadline = lanDeadline()): Promise<Choice> {
  if (!catalogSource.enabled) return ['navidrome', 'off']
  if (usingDesktopCatalog()) return probe(bridge())

  try { return await withinLanDeadline(deadline, () => checkLan(api)) }
  catch { return ['navidrome', 'unavailable'] }
}

/**
 * Decides the catalog for a fresh load of the library. A refresh never calls this: what is
 * on screen keeps its catalog, so a background update cannot swap every album for another.
 */
export async function chooseCatalog(api: SubsonicAPI, isCurrent: () => boolean) {
  const deadline = usingDesktopCatalog() ? undefined : lanDeadline()
  const [active, fallback] = await checkCatalog(api, deadline)
  if (!isCurrent()) return
  selectedAccount = api
  if (catalogSource.enabled) use(active, fallback)
  else use('navidrome', 'off')
  return deadline
}
/** The library's catalog failed while it was being loaded: the music server serves this load. */
export function fallBackToServer() { lanReadiness = undefined; use('navidrome', 'failed') }
export function setCatalogEnabled(enabled: boolean) {
  if (catalogSource.enabled !== enabled) selectedAccount = undefined
  catalogSource.enabled = enabled
  writePreference(PREFERENCE, enabled ? null : OFF)
}

const client = () => { const found = bridge(); if (!found) throw new Error('Your library is not available. Restart Kept.'); return found }
export function albumPages(api: SubsonicAPI, order: 'alphabeticalByArtist' | 'newest', firstPageDeadline?: number): AsyncGenerator<Collection[]> {
  if (catalogSource.active !== 'virtual') return localCatalog.albums(api, order)
  const found = client()
  if (firstPageDeadline === undefined) return virtual.albums(found, order)
  // The readiness probe and first LAN page share the budget for getting albums on screen.
  return virtual.albums({
    ...found,
    catalogAlbums: request => request?.offset === 0
      ? withinLanDeadline(firstPageDeadline, () => found.catalogAlbums(request))
      : found.catalogAlbums(request),
  }, order)
}
// A collection is read from the catalog it came from, whichever one is browsed now.
export function trackPagesOf(api: SubsonicAPI, collection: Collection): AsyncGenerator<Track[]> {
  return isVirtualCollection(collection) ? virtual.tracks(client(), collection) : localCatalog.tracks(api, collection)
}
export function artistAlbumsOf(api: SubsonicAPI, collection: Collection): Promise<Collection[]> {
  return isVirtualCollection(collection) ? virtual.artistAlbums(client(), collection.rawId) : localCatalog.artistAlbums(api, collection.rawId)
}
export type SearchCatalog = (request: CatalogSearchRequest) => Promise<CatalogSearchPage>
export async function catalogSearchFor(api: SubsonicAPI): Promise<SearchCatalog> {
  // Search can start in Playlists, before an album load has picked a catalog for this account.
  const active = selectedAccount === api ? catalogSource.active : (await checkCatalog(api))[0]
  const found = catalogSource.enabled && active === 'virtual' ? bridge() : undefined
  return found ? request => virtual.search(found, request) : request => localCatalog.search(api, request)
}

/**
 * History remembers assets. Refresh their streams when loading history so replay
 * can use the current copy without waiting for the catalog.
 */
export async function primePlayback(tracks: Track[], isCurrent = () => true): Promise<boolean> {
  const assetIds = [...new Set(tracks.map(trackCatalogRef).filter(ref => ref.kind === 'asset').map(ref => ref.id))]
  if (!assetIds.length) return true
  const api = session.api
  const ownsRequest = () => api === session.api && isCurrent()
  if (!ownsRequest()) return false
  const found = bridge() ?? (!window.desktop ? await openLanCatalog() : undefined)
  if (!found || !ownsRequest()) return false
  const updates: { ref: CatalogRef; playback: PlaybackRef | undefined; version: number }[] = []
  try {
    for (let start = 0; start < assetIds.length; start += MAX_PLAYBACK_LINKS) {
      const batch = assetIds.slice(start, start + MAX_PLAYBACK_LINKS)
      const { links, version } = await found.playbackLinks({ assetIds: batch })
      if (!ownsRequest()) return false
      for (const id of batch) {
        const songId = links[id]?.find(link => link.sourceId === NAVIDROME_SOURCE_ID)?.externalId
        updates.push({ ref: { kind: 'asset', id }, playback: songId === undefined ? undefined : { kind: 'navidrome-stream', songId }, version })
      }
    }
  } catch { return false }
  for (const { ref, playback, version } of updates) playbackResolver.update(ref, playback, version)
  return true
}

/**
 * The playable tracks for occurrence IDs the tools returned, in the order given. Each album is read once;
 * an occurrence that is no longer in its album is left out.
 */
export async function tracksByOccurrence(entries: { occurrenceId: string; albumId: string }[]): Promise<Track[]> {
  const albums = await Promise.all([...new Set(entries.map(entry => entry.albumId))].map(albumId => virtual.tracksOf(client(), albumId)))
  const byId = new Map(albums.flat().map(track => [track.id, track]))
  return entries.flatMap(entry => { const track = byId.get(virtualTrackId(entry.occurrenceId)); return track ? [track] : [] })
}

/** The albums of the library's own catalog for IDs the tools returned, in the order given. An album that is gone is left out. */
export async function albumsById(albumIds: string[]): Promise<Collection[]> {
  const found = await Promise.all(albumIds.map(async albumId => (await client().catalogAlbum({ albumId })).album))
  return found.flatMap(detail => { if (!detail) return []; const { tracks: _tracks, ...summary } = detail; return [virtual.album(summary)] })
}

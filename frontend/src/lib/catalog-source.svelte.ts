import type { SubsonicAPI } from 'subsonic-api'
import { coverUrl } from './api.svelte'
import { MAX_PLAYBACK_LINKS, NAVIDROME_SOURCE_ID } from './catalog'
import type { CatalogSearchPage, CatalogSearchRequest } from './catalog-provider'
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
type CatalogSelection = { active: CatalogKind; fallback: CatalogFallback }
const PREFERENCE = 'library.catalog'
const OFF = 'navidrome'
// The job class that reads each file once. While it has work, the library's catalog is still filling up.
const INGEST_JOB_CLASS = 'hash'
export const catalogSource = $state({ enabled: readPreference(PREFERENCE) !== OFF, active: 'navidrome' as CatalogKind, fallback: 'unavailable' as CatalogFallback })

const virtual = createVirtualCatalog({ resolver: playbackResolver, playbackSourceId: NAVIDROME_SOURCE_ID, cover: coverUrl })
// An older desktop build has the bridge without the read model.
const bridge = () => (typeof window.musicCatalog?.catalogAlbums === 'function' ? window.musicCatalog : undefined)
export function setCatalogSelection(selection: CatalogSelection) {
  Object.assign(catalogSource, selection)
}

/**
 * Decides the catalog for a fresh load of the library. A refresh never calls this: what is
 * on screen keeps its catalog, so a background update cannot swap every album for another.
 */
export async function chooseCatalog(): Promise<CatalogSelection> {
  const client = bridge()
  if (!catalogSource.enabled) return { active: 'navidrome', fallback: 'off' }
  if (!client) return { active: 'navidrome', fallback: 'unavailable' }
  try {
    const [page, jobs] = await Promise.all([client.catalogAlbums({ limit: 1 }), window.musicJobs?.status()])
    if (!page.total) return { active: 'navidrome', fallback: 'empty' }
    // Files still being read: the music server already lists every album, the library does not yet.
    const ingest = jobs?.classes[INGEST_JOB_CLASS]
    const reading = !!ingest && ingest.queued + ingest.running > 0
    return reading ? { active: 'navidrome', fallback: 'catching-up' } : { active: 'virtual', fallback: '' }
  } catch { return { active: 'navidrome', fallback: 'failed' } }
}
export function setCatalogEnabled(enabled: boolean) {
  catalogSource.enabled = enabled
  writePreference(PREFERENCE, enabled ? null : OFF)
}

const client = () => { const found = bridge(); if (!found) throw new Error('Your library is not available. Restart Kept.'); return found }
export function albumPages(api: SubsonicAPI, order: 'alphabeticalByArtist' | 'newest'): AsyncGenerator<Collection[]> {
  return catalogSource.active === 'virtual' ? virtual.albums(client(), order) : localCatalog.albums(api, order)
}
// A collection is read from the catalog it came from, whichever one is browsed now.
export function trackPagesOf(api: SubsonicAPI, collection: Collection): AsyncGenerator<Track[]> {
  return isVirtualCollection(collection) ? virtual.tracks(client(), collection) : localCatalog.tracks(api, collection)
}
export function artistAlbumsOf(api: SubsonicAPI, collection: Collection): Promise<Collection[]> {
  return isVirtualCollection(collection) ? virtual.artistAlbums(client(), collection.rawId) : localCatalog.artistAlbums(api, collection.rawId)
}
export function searchCatalogSource(api: SubsonicAPI, request: CatalogSearchRequest): Promise<CatalogSearchPage> {
  return catalogSource.active === 'virtual' ? virtual.search(client(), request) : localCatalog.search(api, request)
}

/**
 * History remembers assets. Refresh their streams when loading history so replay
 * can use the current copy without waiting for the catalog.
 */
export async function primePlayback(tracks: Track[], isCurrent = () => true): Promise<boolean> {
  const found = bridge()
  const assetIds = [...new Set(tracks.map(trackCatalogRef).filter(ref => ref.kind === 'asset').map(ref => ref.id))]
  if (!assetIds.length) return true
  if (!found) return false
  const updates: { ref: CatalogRef; playback: PlaybackRef | undefined; version: number }[] = []
  try {
    for (let start = 0; start < assetIds.length; start += MAX_PLAYBACK_LINKS) {
      const batch = assetIds.slice(start, start + MAX_PLAYBACK_LINKS)
      const { links, version } = await found.playbackLinks({ assetIds: batch })
      if (!isCurrent()) return false
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

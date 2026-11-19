import { albumsById } from './catalog-source.svelte'
import type { Collection } from './music'

/** What the "Sounds like…" lane shows. `listening`: the album has not been analysed yet. */
export type SimilarStatus = 'idle' | 'loading' | 'ready' | 'none' | 'listening' | 'failed'
export const similar = $state({ albumId: '', status: 'idle' as SimilarStatus, albums: [] as Collection[] })
let generation = 0

export const similarAvailable = () => typeof window.musicCatalog?.similarAlbums === 'function'
export function closeSimilar() { generation++; similar.albumId = ''; similar.status = 'idle'; similar.albums = [] }

/**
 * Show sound matches and whether the seed has sound features.
 * A newer request or a close supersedes this one.
 */
export async function findSimilarAlbums(album: Pick<Collection, 'rawId'>) {
  const bridge = window.musicCatalog
  if (!bridge || typeof bridge.similarAlbums !== 'function') return
  const mine = ++generation
  const albumId = album.rawId
  similar.albumId = albumId
  similar.status = 'loading'
  similar.albums = []
  try {
    const { albumIds, analysed } = await bridge.similarAlbums({ albumId })
    if (mine !== generation) return
    if (!albumIds.length) {
      similar.status = analysed ? 'none' : 'listening'
      return
    }
    const albums = await albumsById(albumIds)
    if (mine !== generation) return
    similar.albums = albums
    similar.status = albums.length ? 'ready' : 'none'
  } catch {
    if (mine === generation) similar.status = 'failed'
  }
}

// What the desktop gives the C1 tools: listening history by catalog album. The feature store
// is B1's: until it exists the tools run on traits and metadata.
import { NAVIDROME_SOURCE_ID } from '../shared/catalog-bridge.js'

const LOCAL_ALBUM_PREFIX = 'local:album:'

export function createHistoryStats({ stats }) {
  return {
    async albumStats(albums) {
      const played = await stats()
      const providerAlbums = new Map()
      for (const album of albums.values()) {
        for (const link of album.links) {
          if (link.sourceId === NAVIDROME_SOURCE_ID) providerAlbums.set(link.externalId, album.id)
        }
      }
      const byAlbum = {}
      for (const [storedId, entry] of Object.entries(played)) {
        const local = storedId.startsWith(LOCAL_ALBUM_PREFIX)
        const id = local ? storedId.slice(LOCAL_ALBUM_PREFIX.length) : storedId
        const anchor = local && albums.has(id) ? id : providerAlbums.get(id)
        if (!anchor) continue
        const old = byAlbum[anchor]
        byAlbum[anchor] = { plays: (old?.plays ?? 0) + entry.plays, lastPlayed: Math.max(old?.lastPlayed ?? 0, entry.lastPlayed) }
      }
      return byAlbum
    },
  }
}

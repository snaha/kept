import type { CatalogProvider, CatalogSearchRequest } from './catalog-provider.ts'
import type { CatalogAlbum, CatalogBridge, CatalogLink, CatalogSort, CatalogTrack } from './catalog.ts'
import type { Collection, Track } from './music.ts'
import type { PlaybackResolver } from './playback-ref.ts'

// The catalog the desktop library projects: albums are anchors, tracks are occurrences of
// assets. It is read through the desktop bridge, so it exists only in the desktop app.
export type VirtualCatalogClient = Pick<CatalogBridge, 'catalogAlbums' | 'catalogAlbum' | 'catalogSearch'>
export const VIRTUAL_ALBUM_PAGE = 500
const MAX_QUERY_LENGTH = 200
const MAX_SEARCH_PAGE = 100
const TRACK_COVER_SIZE = 512
const ALBUM_ID_PREFIX = 'album:'
const ARTIST_ID_PREFIX = 'artist:'
const ORDERS: Record<'alphabeticalByArtist' | 'newest', CatalogSort> = { alphabeticalByArtist: 'artist', newest: 'added' }
// Same shape as localId in music.ts, which node-run tests cannot import without a .ts extension the app build rejects.
const localId = (kind: string, id: string) => `local:${kind}:${id}`
const isPlayable = (availability: string) => availability === 'available' || availability === 'partial'

// An anchor ID always has a colon and a music server ID never does, so a collection tells
// which catalog it came from, also after the app has fallen back to the other one.
export const isVirtualCollection = (collection: Pick<Collection, 'kind' | 'rawId'>) =>
  collection.kind !== 'playlist' && (collection.rawId.startsWith(ALBUM_ID_PREFIX) || collection.rawId.startsWith(ARTIST_ID_PREFIX))

export type VirtualCatalogOptions = {
  resolver: PlaybackResolver
  // The source whose links name the stream an asset plays through and the cover of an album (Navidrome today).
  playbackSourceId: string
  // The address of a cover, given the ID the playback source knows it by.
  cover(id: string | undefined, size?: number): string
}

export function createVirtualCatalog(options: VirtualCatalogOptions) {
  const { resolver, playbackSourceId, cover } = options
  const linked = (links: CatalogLink[]) => links.filter(link => link.sourceId === playbackSourceId).map(link => link.externalId)
  // The album's cover as the music server serves it, found through the newest link.
  const coverId = (album: CatalogAlbum) => { const [id] = linked(album.links); return id === undefined ? undefined : `al-${id}` }

  const album = (item: CatalogAlbum): Collection => ({
    id: localId('album', item.id), rawId: item.id, source: 'local', kind: 'album', cover: cover(coverId(item)),
    title: item.title ?? 'Unknown album', sub: item.artist ?? '', count: item.trackCount, available: isPlayable(item.availability),
    favorite: item.favorite, year: item.year, genres: item.genre ? [item.genre] : [], addedAt: new Date(item.addedAt).toISOString(),
    aliases: linked(item.links).map(id => localId('album', id)),
  })
  // Catalog IDs stay distinct: the track id names the occurrence, catalogRef names the asset,
  // and the queue entry id is added by the player.
  const track = (owner: CatalogAlbum, item: CatalogTrack, version: number): Track => {
    const [songId] = linked(item.links)
    const catalogRef = { kind: 'asset', id: item.assetId } as const
    // Registered as it is handed out, so playing it never waits on the catalog.
    const playback = songId !== undefined && item.availability === 'available' ? { kind: 'navidrome-stream', songId } as const : undefined
    resolver.update(catalogRef, playback, version)
    return {
      id: localId('track', item.id), rawId: item.assetId, source: 'local', catalogRef,
      title: item.title ?? 'Unknown track', artist: item.artist ?? owner.artist, album: owner.title ?? 'Unknown album', albumId: localId('album', owner.id),
      coverId: coverId(owner), cover: cover(coverId(owner), TRACK_COVER_SIZE), duration: item.duration, track: item.track, disc: item.disc,
      available: resolver.resolve(catalogRef) !== undefined,
    }
  }
  const artist = (name: string, albumCount: number): Collection => ({
    id: localId('artist', name), rawId: `${ARTIST_ID_PREFIX}${name}`, source: 'local', kind: 'artist', title: name, sub: 'Artist', cover: '', count: albumCount, available: true,
  })

  const tracksOf = async (client: VirtualCatalogClient, albumId: string) => {
    const { album: detail, version } = await client.catalogAlbum({ albumId })
    return detail ? detail.tracks.map((item, position) => ({ ...track(detail, item, version), playbackOriginIndex: position })) : []
  }
  const provider = {
    source: 'local' as const,
    capabilities: { search: true, playlists: false, pagedAlbums: true },
    album, track, tracksOf,
    // The projection orders the pages. An album that moved between two pages while they were read is listed once.
    async *albums(client: VirtualCatalogClient, order: 'alphabeticalByArtist' | 'newest', artist?: string): AsyncGenerator<Collection[]> {
      const seen = new Set<string>()
      for (let offset = 0; ;) {
        const page = await client.catalogAlbums({ offset, limit: VIRTUAL_ALBUM_PAGE, sort: ORDERS[order], artist })
        const fresh = page.albums.filter(item => !seen.has(item.id))
        for (const item of fresh) seen.add(item.id)
        yield fresh.map(album)
        offset += page.albums.length
        if (!page.albums.length || offset >= page.total) return
      }
    },
    // Playlists stay with the music server.
    async playlists() { return [] as Collection[] },
    async artistAlbums(client: VirtualCatalogClient, id: string) {
      const name = id.startsWith(ARTIST_ID_PREFIX) ? id.slice(ARTIST_ID_PREFIX.length) : id
      const found: Collection[] = []
      for await (const page of provider.albums(client, 'alphabeticalByArtist', name)) found.push(...page)
      return found
    },
    async *tracks(client: VirtualCatalogClient, collection: Collection): AsyncGenerator<Track[]> {
      if (collection.source !== 'local' || collection.kind === 'playlist') throw new Error('Unsupported catalog source.')
      if (collection.kind === 'album') { yield await tracksOf(client, collection.rawId); return }
      const albums = await provider.artistAlbums(client, collection.rawId)
      if (albums.length) yield await tracksOf(client, albums[Math.floor(Math.random() * albums.length)].rawId)
    },
    async search(client: VirtualCatalogClient, request: CatalogSearchRequest) {
      const page = (count: number, offset: number) => (count > 0 ? { offset, limit: Math.min(count, MAX_SEARCH_PAGE) } : undefined)
      const found = await client.catalogSearch({
        query: request.query.slice(0, MAX_QUERY_LENGTH), albums: page(request.albumCount, request.albumOffset),
        artists: page(request.artistCount, request.artistOffset), tracks: page(request.songCount, request.songOffset),
      })
      const owners = new Map([...found.albums, ...found.trackAlbums].map(item => [item.id, item]))
      return {
        collections: found.albums.map(album), artists: found.artists.map(item => artist(item.name, item.albumCount)), related: found.trackAlbums.map(album),
        tracks: found.tracks.flatMap(item => { const owner = owners.get(item.albumId); return owner ? [track(owner, item, found.version)] : [] }),
      }
    },
  } satisfies CatalogProvider<VirtualCatalogClient> & Record<string, unknown>
  return provider
}

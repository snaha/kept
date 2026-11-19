import type { Collection, Source, Track } from './music';
export type CatalogSearchRequest = { query: string; albumCount: number; albumOffset: number; artistCount: number; artistOffset: number; songCount: number; songOffset: number };
// related: the albums of the tracks found, when they are not among the collections found.
export type CatalogSearchPage = { collections: Collection[]; artists: Collection[]; tracks: Track[]; related?: Collection[] };
export interface CatalogProvider<Client> {
  readonly source: Source;
  readonly capabilities: { search: boolean; playlists: boolean; pagedAlbums: boolean };
  albums(client: Client, order: 'alphabeticalByArtist' | 'newest'): AsyncGenerator<Collection[]>;
  playlists(client: Client): Promise<Collection[]>;
  artistAlbums(client: Client, id: string): Promise<Collection[]>;
  tracks(client: Client, collection: Collection): AsyncGenerator<Track[]>;
  search(client: Client, request: CatalogSearchRequest): Promise<CatalogSearchPage>;
}

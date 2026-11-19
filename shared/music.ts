export type Source = 'local';
// Names an entity in the catalog. 'navidrome' is a Navidrome song id (legacy rows have no ref and
// mean this); 'asset' is a virtual catalog asset id. It is never what an audio element loads.
export type CatalogRef = { kind: 'navidrome' | 'asset'; id: string };
export type Track = {
  id: string; rawId: string; source: Source; title: string; artist?: string; album?: string;
  albumId?: string; coverId?: string; cover: string; duration?: number; track?: number; disc?: number;
  playbackOrigin?: Pick<Collection, 'id' | 'rawId' | 'source' | 'kind' | 'title' | 'cover'>;
  playbackOriginIndex?: number;
  catalogRef?: CatalogRef; // Absent means { kind: 'navidrome', id: rawId }.
  queueEntryId?: string; // Identity of this occurrence in the live queue, independent of track/catalog IDs.
  albumInfo?: Collection; origins?: { id: string; title: string; kind: string }[];
  available: boolean;
};
export type Collection = {
  id: string; rawId: string; source: Source; kind: 'album' | 'artist' | 'playlist';
  title: string; sub: string; cover: string; count: number;
  available: boolean; incomplete?: boolean; addedAt?: string; indexing?: boolean; favorite?: boolean; origins?: string[];
  year?: number; genres?: string[];
  aliases?: string[]; // Other collection IDs this one answers to: what the music server calls an album of the catalog.
};

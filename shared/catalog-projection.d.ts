import type { EntityRef, JsonValue, ScanTags } from './catalog'
import type { AlbumView, AssetView, CatalogAlbum, CatalogAlbumDetail, CatalogArtist, CatalogSearchKind, CatalogSort, CatalogTrack } from './catalog'

export type ProjectedAlbum = Omit<CatalogAlbumDetail, 'version'>
export type SearchRow = { kind: 'album' | 'track'; id: string; albumId: string; title: string; artist: string }

export const PROJECTION_FORMAT: number
export const DEFAULT_SEARCH_LIMIT: number
export const MAX_SEARCH_LIMIT: number
export const MAX_CATALOG_QUERY_LENGTH: number
export const CATALOG_SORTS: readonly CatalogSort[]
export const SEARCH_KINDS: readonly CatalogSearchKind[]
export const MAX_REPORTED_DIFFERENCES: number
export const MAX_TAG_LENGTH: number
export function sortKey(text: unknown): string
export function searchTerms(text: unknown): string[]
export function ftsQuery(terms: readonly string[]): string
export function matchesTerms(terms: readonly string[], ...texts: unknown[]): boolean
export function projectAlbum(view: AlbumView, assetOf: (assetId: string) => Pick<AssetView, 'duration' | 'fields' | 'availability' | 'playbackLinks'>, locks: readonly string[], addedAt: number): ProjectedAlbum
export function albumSummary(album: ProjectedAlbum, version: number): CatalogAlbum
export function albumDetail(album: ProjectedAlbum, version: number): CatalogAlbumDetail
export function searchRows(album: ProjectedAlbum): SearchRow[]
export function compareAlbums(sort: Exclude<CatalogSort, 'added'>): (a: ProjectedAlbum, b: ProjectedAlbum) => number
export function compareTracks(a: CatalogTrack, b: CatalogTrack): number
export function compareArtists(a: CatalogArtist, b: CatalogArtist): number
export function isScanTags(tags: unknown): tags is ScanTags
export function tagObservations(files: readonly { assetId: string; tags?: ScanTags }[], albumOf: (assetId: string) => string | undefined): { subject: EntityRef; field: string; value: JsonValue }[]
export function normalSearch(request: unknown): { terms: string[]; kinds: readonly CatalogSearchKind[]; limit: number; offset: number }

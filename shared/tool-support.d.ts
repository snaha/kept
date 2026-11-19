import type { CatalogAlbum, CatalogAlbumDetail, CatalogService, CatalogTrack, TraitName, TraitValues } from './catalog'

export const FOLDER_BONUS_WEIGHT: number
export const RANK_WEIGHTS: Readonly<{ traits: number; similarity: number; novelty: number }>
export const SIMILAR_WEIGHTS: Readonly<{ similarity: number; novelty: number }>
export const NEUTRAL_SCORE: number
export const FULL_FAMILIARITY_PLAYS: number
export const TRACK_VECTOR_SHARE: number
export const SEARCH_FETCH_LIMIT: number
export const SCORE_PRECISION: number
export const DEFAULT_MAX_PER_ALBUM: number
export const ARTIST_SPACING: number
export const ALBUM_SPACING: number
export const QUEUE_POOL_FACTOR: number
export const MIN_POOL_ALBUMS: number
export function clampScore(value: number): number
export function roundScore(value: number): number
export function compareText(a: string, b: string): number
export function normalName(value: unknown): string | undefined
export function cosine(a: ArrayLike<number> | undefined, b: ArrayLike<number> | undefined): number | undefined
export function hybridScore(similarity: number, sameFolder: boolean): number
export function familiarity(plays?: number): number
export function noveltyFit(novelty: number, plays: number): number
export function traitFit(targets: Partial<Record<TraitName, number>> | undefined, traits: TraitValues | undefined): number | undefined
export function blend<Part extends string>(parts: Partial<Record<Part, number | undefined>>, weights: Record<Part, number>): number | undefined
export function byScore(a: { score: number; id?: string }, b: { score: number; id?: string }): number

export type CatalogSnapshot = {
  version: number
  albums: ReadonlyMap<string, CatalogAlbum>
  detail(albumId: string): Promise<CatalogAlbumDetail | undefined>
  folders(albumIds: string[]): Promise<Map<string, string | undefined>>
  tracks(): Promise<Map<string, { track: CatalogTrack; albumId: string }>>
}
export function createCatalogSnapshot(catalog: CatalogService): { load(): Promise<CatalogSnapshot> }

import type {
  AlbumView, CatalogAlbum, CatalogAlbumDetail, CatalogArtist, CatalogLink, CatalogService, CatalogTrack, CommitRejection, ConsentKey, ConsentRecord, TraitName,
  TraitValues, UndoResult,
} from './catalog'

// An album as the frontend needs it: its anchor, the user's favourite and its traits with provenance.
export type AlbumState = { albumId: string; favorite: boolean; availability: AlbumView['availability']; traits: TraitValues }
export type MigrationAlbum = { providerAlbumId: string; favorite?: boolean; traits?: Partial<Record<TraitName, number>> }
// applied is false while the provider album has no anchor yet (it has not been scanned).
export type DecisionReceipt = { applied: boolean }
// One operation of a change set, compared: what it changed, with the value before and after.
export type OperationReceipt = { index: number; label: string; before?: string; after?: string; undone: boolean }
// One change set as the Activity list shows it. undone entries stay listed as a receipt.
// route: the route that proposed an automated change.
export type ActivityReceipt = {
  id: string; at: number; actor: 'you' | 'kept'; route?: string; summary: string; detail?: string; undone: boolean; undoable: boolean
  operations: OperationReceipt[]
}
// An album named by the provider's ID, or by its anchor once the window browses the catalog.
export type AlbumTarget = { providerAlbumId: string; albumId?: undefined } | { albumId: string; providerAlbumId?: undefined }
export type SearchPage = { offset: number; limit: number }
// A kind with no page is not searched.
export type CatalogSearchQuery = { query: string; albums?: SearchPage; artists?: SearchPage; tracks?: SearchPage }
// trackAlbums: the albums of the tracks found that are not among the albums found.
export type CatalogSearchResult = { albums: CatalogAlbum[]; artists: CatalogArtist[]; tracks: CatalogTrack[]; trackAlbums: CatalogAlbum[]; version: number }
export type ReviewField = 'title' | 'artist' | 'year' | 'genre'
// Who the value comes from: the user, the file tags, or a route (by names it).
export type FieldOrigin = 'user' | 'tags' | 'route'
export type FieldReview = { field: ReviewField; value?: string | number; origin?: FieldOrigin; by?: string; locked: boolean; undoable: boolean }
export type FieldReceipt = { applied: true } | { applied: false; reason: CommitRejection }
export type UndoReceipt = { status: 'undone' } | { status: 'blocked'; reason: Extract<UndoResult, { status: 'blocked' }>['reason']; blockedBy: string[] }
export type CatalogBridge = {
  albums(): Promise<{ albums: Record<string, AlbumState> }>
  setTrait(request: AlbumTarget & { trait: TraitName; value?: number; changeId?: string }): Promise<DecisionReceipt>
  setFavorite(request: AlbumTarget & { value: boolean; changeId?: string }): Promise<DecisionReceipt>
  migrate(request: { decidedAt: number; albums: MigrationAlbum[] }): Promise<{ migrated: string[]; pending: string[] }>
  activity(request?: { offset?: number, limit?: number }): Promise<{ entries: ActivityReceipt[], total: number }>
  undo(request: { id: string; operations?: number[] }): Promise<UndoReceipt>
  catalogAlbums(request?: Parameters<CatalogService['listCatalogAlbums']>[0]): Promise<{ albums: CatalogAlbum[]; total: number; version: number }>
  catalogAlbum(request: { albumId: string }): Promise<{ album?: CatalogAlbumDetail; version: number }>
  catalogSearch(request: CatalogSearchQuery): Promise<CatalogSearchResult>
  playbackLinks: CatalogService['getPlaybackLinks']
  albumReview(request: { albumId: string }): Promise<{ fields: FieldReview[]; version: number }>
  setField(request: { albumId: string; field: ReviewField; value: string | number; changeId?: string }): Promise<FieldReceipt>
  lockField(request: { albumId: string; field: ReviewField; locked: boolean; changeId?: string }): Promise<FieldReceipt>
  undoField(request: { albumId: string; field: ReviewField }): Promise<UndoReceipt>
  consent(): Promise<ConsentRecord>
  setConsent(request: { consent: ConsentKey; value: 'granted' | 'denied' }): Promise<ConsentRecord>
}
export type CatalogBridgeOperation = 'albums' | 'set-trait' | 'set-favorite' | 'migrate' | 'consent' | 'set-consent' | 'activity' | 'undo'
  | 'catalog-albums' | 'catalog-album' | 'catalog-search' | 'playback-links' | 'album-review' | 'set-field' | 'lock-field' | 'undo-field'

export const NAVIDROME_SOURCE_ID: string
export const CATALOG_BRIDGE_METHODS: Readonly<Record<CatalogBridgeOperation, keyof CatalogBridge>>
export const MAX_MIGRATION_ALBUMS: number
export const ACTIVITY_PAGE: number
export const MAX_ACTIVITY_PAGE: number
export const TRAIT_COALESCE_MS: number
export const CATALOG_CHANGING_OPERATIONS: readonly CatalogBridgeOperation[]
export const REVIEW_FIELDS: readonly ReviewField[]
export const MAX_ALBUM_PAGE: number
export const MAX_PLAYBACK_LINKS: number
export const MAX_YEAR: number
export function validateCatalogBridgeRequest(method: string, args: unknown[]): unknown
export function createCatalogBridge(service: CatalogService, options?: { now?: () => number; providerSourceId?: string; newId?: () => string }): CatalogBridge

import type {
  CatalogSource, CatalogService, ChangeSet, EntityRef, JsonValue, Observation, ProviderLink, SourceInput,
} from './catalog'

// A track's place in an anchor, as the spine stores it.
export type MemberPlace = { albumId: string; disc?: number; track?: number; path: string }
export type StoredDecision = { value?: JsonValue; decidedAt: number }
// A stored change set: the ChangeSet plus the writes of each operation and its index keys.
export type LedgerRecord = Omit<ChangeSet, 'dependents'> & { seq: number; fingerprint: string; keys: string[]; suppressed?: boolean }
// What the ledger needs of the spine. Every call is synchronous and runs inside transaction().
export type LedgerStore = {
  transaction<T>(body: () => T): T // rolls back everything when body throws
  version(): number
  flush(): number // brings the projections up to date and returns the catalog version
  subjectVersion(subject: EntityRef): number
  touch(subject: EntityRef): void
  requireSubject(subject: EntityRef): EntityRef
  findSource(id: string): SourceInput | CatalogSource | undefined
  findObservation(id: string): Observation | undefined
  memberOf(assetId: string): MemberPlace | undefined
  membersOf(albumId: string): (MemberPlace & { assetId: string })[]
  setMember(assetId: string, place: MemberPlace | undefined, restoring: boolean): void
  newAlbum(createdAt: number): string
  albumLinks(albumId: string): ProviderLink[]
  findLink(sourceId: string, kind: string, externalId: string): ProviderLink | undefined
  setLink(link: ProviderLink): void
  removeLink(sourceId: string, kind: string, externalId: string): void
  decision(kind: string, subject: EntityRef, trait: string): StoredDecision | undefined
  setDecision(kind: string, subject: EntityRef, trait: string, value: JsonValue | undefined, decidedAt: number): void
  override(subject: EntityRef, field: string): unknown
  setOverride(subject: EntityRef, field: string, value: unknown): void
  lock(subject: EntityRef, field: string): string | undefined
  setLock(subject: EntityRef, field: string, changeSetId: string | undefined): void
  findChangeSet(id: string): LedgerRecord | undefined
  insertChangeSet(record: LedgerRecord): void // assigns seq
  updateChangeSet(record: LedgerRecord): void
  changeSetsByKeys(keys: string[]): LedgerRecord[] // oldest first
  changeSetPage(page: { offset: number; limit: number }): { records: LedgerRecord[]; total: number } // newest first
  suppression(author: string, fingerprint: string): string | undefined
  setSuppression(author: string, fingerprint: string, changeSetId: string): void
}
type Sync<T> = { [K in keyof T]: T[K] extends (request: infer R) => Promise<infer V> ? (request: R) => V : never }
export type Ledger = Sync<Pick<CatalogService, 'commitChangeSet' | 'undoChangeSet' | 'undoField' | 'getChangeSet' | 'listChangeSets'>>

export const DEFAULT_CHANGE_PAGE: number
export const MAX_CHANGE_PAGE: number
export const MAX_OPERATIONS: number
export const MAX_SUMMARY_LENGTH: number
export function createLedger(store: LedgerStore): Ledger
export function trackNumbering(assetIds: string[], changeSetsByKeys: LedgerStore['changeSetsByKeys']): Map<string, Pick<MemberPlace, 'disc' | 'track'>>

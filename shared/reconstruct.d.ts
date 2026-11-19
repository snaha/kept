import type {
  ChangeOperation, ConsentKey, EntityRef, JsonValue, ReconstructionNeed, ReconstructionStatus, RouteAttempt, RouteId, RouteOutcome, RouteStatus, SourceInput,
} from './catalog'
import type { ProviderRelease } from './reconstruct-match'

export const LOCAL_POLICY: string
export const LADDER_POLICY: string
export const MUSICBRAINZ_SOURCE_ID: 'musicbrainz'
export const ACOUSTID_SOURCE_ID: 'acoustid'
export const MUSICBRAINZ_SOURCE: SourceInput
export const ACOUSTID_SOURCE: SourceInput
export const ROUTES: readonly { stage: number; id: RouteId; source?: string }[]
export const ROUTE_STATUSES: readonly RouteStatus[]
export const NEEDS: readonly ReconstructionNeed[]
export const VARIOUS_ARTISTS: string
export const RELEASE_GROUP_FIELD: string
export const RELEASE_FIELD: string

export type ClusterAlbum = {
  id: string
  seq: number // creation order
  title?: string
  artist?: string
  year?: number
  locks?: string[]
  userFields?: string[] // fields the user set: never proposed over
  links?: { sourceId: string; externalId: string }[]
  evidence?: { title?: string; artist?: string } // observation IDs
}
export type ClusterTrack = {
  assetId: string
  albumId: string
  disc?: number
  track?: number
  sourceId: string
  path: string // relative to the source root
  available?: boolean
  title?: string
  artist?: string
  duration?: number
  locks?: string[]
  userFields?: string[]
  evidence?: { title?: string }
}
export type ReconstructionCluster = {
  seed: string
  version?: number // the catalog version it was read at
  albums: ClusterAlbum[]
  tracks: ClusterTrack[]
  permissions?: Record<string, RouteOutcome> // by source ID
  previous?: { inputHash: string; policy: string; status: ReconstructionStatus; online: boolean; retry: boolean }
  cache?: { key: string; value?: JsonValue }[]
}
export type EmbeddedTags = { releaseId?: string; recordingId?: string; releaseGroupId?: string; compilation?: boolean; albumArtist?: string }
// Throws an Error with code 'cache-miss', 'budget' or 'network' when it cannot answer.
export type ReconstructionProvider = {
  release(id: string): Promise<ProviderRelease | undefined>
  searchReleases(query: { title: string; artist?: string }): Promise<string[]>
  searchRecordings(query: { title: string; artist: string }): Promise<string[]>
  requests?(): number
}
export type LadderTools = {
  readEmbedded?: (track: ClusterTrack) => EmbeddedTags | undefined | Promise<EmbeddedTags | undefined>
  provider?: ReconstructionProvider
  cachedProvider?: ReconstructionProvider // answers from the cache only
  fingerprint?: (state: unknown) => Promise<{ status: RouteStatus; detail?: string }>
  rest?: () => Promise<void>
}
// Evidence names a stored observation, a registered source, or an observation of this result by its key.
export type ProposedEvidence = { observationId?: string; sourceId?: string; observation?: string }
export type ProposedChangeSet = { key: string; route: RouteId; operations: ChangeOperation[]; evidence: ProposedEvidence[]; dependsOn: string[]; summary: string }
export type ProposedObservation = { key: string; sourceId: string; subject: EntityRef; field: string; value: JsonValue }
export type LadderResult = {
  seed: string
  survivor: string // the album the seed's tracks are in after the proposed merges
  status: ReconstructionStatus
  online: boolean
  needs: ReconstructionNeed[]
  inputHash: string
  policy: string
  outcomes: RouteAttempt[]
  observations: ProposedObservation[]
  changeSets: ProposedChangeSet[]
  blockedBy: ConsentKey[]
  retry: boolean
  reused?: boolean
}

export function digest(value: unknown): string
export function clusterInputHash(cluster: ReconstructionCluster, embedded: Map<string, EmbeddedTags>): string
export function runLadder(cluster: ReconstructionCluster, tools?: LadderTools): Promise<LadderResult>

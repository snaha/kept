// Core DTOs of the Kept identity spine (plan phase A0). Types only: every value
// crosses the worker/IPC boundary as plain JSON, so absent means a missing key.
// Runtime rules live in catalog-rules.js, the in-memory service in catalog-fake.js.

export type JsonValue = string | number | boolean | JsonValue[] | { [key: string]: JsonValue }

// Every catalog ID (source, asset, album, occurrence, observation, decision) is an
// opaque string matching ID_PATTERN: it can never be a path.
export type EvidenceClass = 'deterministic' | 'user' | 'model'
export type SourceKind =
  | 'local-folder' | 'navidrome' | 'musicbrainz' | 'acoustid' | 'cover-art-archive' | 'lrclib'
  | 'user' | 'model' | 'spotify'
// Ordered from least to most restrictive in LICENCE_ORDER.
export type LicenceId =
  | 'user' | 'CC0-1.0' | 'MIT' | 'CC-BY-4.0' | 'non-commercial' | 'CC-BY-NC-SA-3.0' | 'unknown' | 'proprietary'
export type SourceNetwork = 'none' | 'lan' | 'internet'
export type ConsentKey = 'online-lookups' | 'acoustid' | 'spotify'
export type ConsentState = 'not-asked' | 'granted' | 'denied'
export type SourceConsentState = ConsentState | 'not-required'

export type SourcePolicy = {
  analysisAllowed: boolean
  network: SourceNetwork
  // The user consent this source needs before it may be used. Required when network is 'internet'.
  consent?: ConsentKey
}
// Registry entry. kind, evidenceClass and licence are fixed once registered.
export type SourceInput = {
  id: string
  kind: SourceKind
  label: string
  evidenceClass: EvidenceClass
  licence: LicenceId
  policy: SourcePolicy
}
export type CatalogSource = SourceInput & { consentState: SourceConsentState }
// Whether a route may use a source: the answer of routeSource.
export type RouteOutcome =
  | { status: 'permitted' }
  | { status: 'not-permitted-by-user'; consent: ConsentKey }

// The reconstruction ladder (plan phase A4). Routes run over one album-sized cluster in order of
// cost, and each one that ran leaves an attempt. Runtime: reconstruct.js.
export type RouteId = 'decisions' | 'local-tags' | 'folder-structure' | 'provider-cache' | 'musicbrainz-ids' | 'musicbrainz-search' | 'acoustid'
// 'no-match': the route looked and found nothing. 'ambiguous': it found candidates it could not
// choose between. 'unavailable': a tool or a credential is missing. 'deferred': held back by a
// budget. 'not-permitted-by-user': the source needs a consent the user has not given.
export type RouteStatus =
  | 'succeeded' | 'no-match' | 'ambiguous' | 'not-applicable' | 'unavailable' | 'deferred' | 'retryable-failure' | 'not-permitted-by-user'
export type RouteAttempt = {
  route: RouteId
  stage: number
  status: RouteStatus
  policy: string // the versions of the policies it ran under
  inputHash: string // of the cluster, the embedded identifiers and the permissions it read
  requests: number // network requests it sent
  consent?: ConsentKey // 'not-permitted-by-user'
  retry?: 'later' // 'deferred' and 'retryable-failure'
  detail?: string
}
export type ReconstructionNeed = 'grouping' | 'title' | 'artist' | 'numbering' | 'track-titles' | 'edition'
// 'resolved': nothing is left to repair, though the edition may be unknown. 'gone': the album no longer has tracks.
export type ReconstructionStatus = 'resolved' | 'unresolved' | 'gone'
export type ReconstructionAttempt = {
  albumId: string
  status: ReconstructionStatus
  needs: ReconstructionNeed[] // what is still open
  outcomes: RouteAttempt[]
  blockedBy: ConsentKey[] // consents that would let more routes run
  online: boolean
  retry: boolean
  inputHash: string
  policy: string
  catalogVersion: number
  updatedAt: number
}

export type EntityRef = { kind: 'album' | 'asset'; id: string }

// An audio file identity, independent of where the file is. contentHash covers the
// audio payload only, so re-tagging or moving a file keeps its asset.
export type Asset = { id: string; contentHash: string; size: number; duration?: number }
// 'unavailable': the root is offline. 'missing': the root is online and the file is gone.
export type Availability = 'available' | 'unavailable' | 'missing'
export type AssetLocation = { assetId: string; sourceId: string; path: string; availability: Availability; seenAt: number }
export type ProviderLink = {
  sourceId: string
  kind: 'album' | 'track'
  externalId: string
  subject: EntityRef
  evidenceClass: Exclude<EvidenceClass, 'model'>
  linkedAt: number
}

export type ScanFile = {
  path: string // relative to the source root
  contentHash: string
  size: number
  duration?: number
  disc?: number
  track?: number
  providerTrackId?: string
  providerAlbumId?: string
  tags?: ScanTags
}
export type ScanSnapshot = {
  sourceId: string // the root the paths belong to
  observedAt: number
  rootAvailable: boolean // false marks every location of the source 'unavailable' and ignores files
  complete: boolean // true marks locations of the source that are not listed as 'missing'
  providerSourceId?: string // the source that issued providerTrackId / providerAlbumId
  files: ScanFile[]
}
// What the scanner read from the file's tags. Stored as observations of the scanned source.
export type ScanTags = { title?: string; artist?: string; album?: string; albumArtist?: string; year?: number; genre?: string }
// An asset whose provider album disagrees with its anchor. Nothing is merged or split.
export type ScanConflict = { assetId: string; albumId: string; providerAlbumId: string; linkedAlbumId?: string }
export type ScanResult = { assetIds: string[]; albumIds: string[]; conflicts: ScanConflict[] }

export type ObservationInput = {
  sourceId: string
  subject: EntityRef
  field: string // 'trait.<name>' for traits, otherwise a metadata field such as 'title'
  value: JsonValue
  observedAt: number
  derivedFrom?: string[] // observation IDs this one was computed from
}
// evidenceClass and licence are set by the service: a derived observation carries the
// most restrictive licence of its inputs and is 'model' if any input is.
export type Observation = ObservationInput & { id: string; evidenceClass: EvidenceClass; licence: LicenceId }

export type TraitName = 'mood' | 'energy' | 'acoustic' | 'vocal'
export type UserDecisionInput =
  | { kind: 'trait'; subject: EntityRef; trait: TraitName; value?: number; decidedAt: number } // no value clears it
  | { kind: 'favorite'; subject: EntityRef; value: boolean; decidedAt: number }
  | { kind: 'consent'; consent: ConsentKey; value: 'granted' | 'denied'; decidedAt: number }
export type UserDecision = UserDecisionInput & { id: string; sourceId: string }
export type ConsentRecord = Record<ConsentKey, ConsentState>

export type FieldValue = {
  value: JsonValue; evidenceClass: EvidenceClass; sourceId: string; licence: LicenceId; observedAt: number
  changeSetId?: string // the applied change set that set the value, when it stands in front of what the sources observed
}
export type TraitProvenance = 'hand-set' | 'estimated'
export type TraitValue = { value: number; provenance: TraitProvenance; sourceId: string; licence: LicenceId; observedAt: number }
export type TraitValues = Partial<Record<TraitName, TraitValue>>
// A track's place in an album. The ID survives reordering and provider re-IDs.
export type TrackOccurrence = { id: string; albumId: string; assetId: string; position: number; disc?: number; track?: number }
export type AssetView = Asset & {
  albumId?: string
  favorite: boolean
  availability: Availability
  analysisAllowed: boolean
  traits: TraitValues
  fields: Record<string, FieldValue>
  locations: AssetLocation[]
  links: ProviderLink[]
  playbackLinks: CatalogLink[]
}
export type AlbumView = {
  id: string
  favorite: boolean
  availability: Availability | 'partial'
  traits: TraitValues
  fields: Record<string, FieldValue>
  tracks: TrackOccurrence[]
  links: ProviderLink[]
}

export type CatalogChangeKind = 'merge' | 'split' | 'rename' | 'set-field'
export type ChangeEvidence = { evidenceClass: EvidenceClass; supports: boolean; sourceId?: string; observationId?: string }
export type CatalogChange = { kind: CatalogChangeKind; subjects: EntityRef[]; evidence: ChangeEvidence[] }
export type ChangeVerdict =
  | { approvable: true; basis: 'user' | 'deterministic' }
  | { approvable: false; reason: 'no-evidence' | 'model-only' | 'contradicted' | 'rejected-by-user' }

// The change ledger (plan phase A1b). A change set is an atomic group of operations: all of
// them apply in one transaction or none does.
// A job that runs a route names it, so a proposal the user undid stays suppressed for that route.
export type ChangeAuthor = { kind: 'user' } | { kind: 'route'; id: string } | { kind: 'job'; id: string; route?: string }
export type ChangeOperation =
  // 'trait.<name>' is a hand-set trait and 'favorite' the favourite: both are user decisions and
  // only the user may set them. No value clears the field.
  | { kind: 'set-field'; subject: EntityRef; field: string; value?: JsonValue }
  // Only the user locks. A locked field refuses automated changes. The field 'tracks' of an
  // album locks its membership, and 'links' its provider links.
  | { kind: 'lock-field'; subject: EntityRef; field: string; locked: boolean }
  | { kind: 'merge-albums'; into: string; from: string[] }
  | { kind: 'split-album'; albumId: string; assetIds: string[] } // the assets move to a new anchor
  | { kind: 'move-track'; assetId: string; albumId: string; disc?: number; track?: number }
  | { kind: 'relink-provider'; sourceId: string; linkKind: 'album' | 'track'; externalId: string; subject: EntityRef }
export type ChangeOperationKind = ChangeOperation['kind']
// Names a registered source or a stored observation. The service reads the evidence class
// from it, so an author can never claim a class. Exactly one of the two IDs is given.
export type ChangeEvidenceRef = { supports: boolean; sourceId?: string; observationId?: string }
export type ChangeSetInput = {
  id: string // chosen by the author: committing the same ID again applies nothing twice
  author: ChangeAuthor
  operations: ChangeOperation[]
  evidence?: ChangeEvidenceRef[] // a user author is user evidence in itself
  dependsOn?: string[] // earlier change sets this one builds on
  // The catalog version the change was computed against. Required unless the author is the user.
  baseVersion?: number
  committedAt: number
  summary?: string
  // A user change set this one continues: a single set-field on the same subject and field,
  // still applied with nothing built on it. The value then joins that change set, which keeps
  // its ID and the value from before it. When it cannot, this one is committed on its own.
  amends?: string
}
// 'superseded': every effect was overwritten by later change sets. 'suppressed': an automated
// change the user undid, which its route may not apply again.
export type ChangeSetState = 'applied' | 'undone' | 'superseded' | 'suppressed'
// before: what a set-field replaced, as the catalog showed it then. Absent when the field had no value.
export type AppliedOperation = { operation: ChangeOperation; state: 'applied' | 'undone'; createdAlbumId?: string; before?: JsonValue }
// causedBy: the change set whose undo took this one with it.
export type UndoRecord = { operations: number[]; author: ChangeAuthor; undoneAt: number; causedBy?: string }
export type ChangeSet = {
  id: string
  author: ChangeAuthor
  operations: AppliedOperation[]
  evidence: ChangeEvidence[]
  verdict: Extract<ChangeVerdict, { approvable: true }>
  dependsOn: string[]
  dependents: string[] // applied change sets that must be undone first, or with it
  state: ChangeSetState
  committedAt: number
  version: number // the catalog version after the commit
  summary?: string
  undos: UndoRecord[]
}
export type FieldLock = { subject: EntityRef; field: string }
export type CommitRejection = 'not-approvable' | 'locked' | 'suppressed' | 'stale' | 'dependency-not-applied'
export type CommitResult =
  // rebased: computed against an older version that none of its subjects changed since.
  // replayed: this ID was already committed, so nothing was applied again.
  | { status: 'applied'; changeSet: ChangeSet; version: number; rebased: boolean; replayed: boolean }
  | {
    status: 'rejected'
    reason: CommitRejection
    version: number
    verdict?: ChangeVerdict // 'not-approvable'
    locks?: FieldLock[] // 'locked'
    suppressedBy?: string // 'suppressed': the change set the user undid
    subjects?: EntityRef[] // 'stale': what changed since baseVersion
    dependsOn?: string[] // 'dependency-not-applied'
  }
export type UndoRequest = {
  id: string
  operations?: number[] // indexes into the change set: every operation when absent
  cascade?: boolean // also undo the dependents instead of reporting them
  author?: ChangeAuthor // the user when absent
  undoneAt: number
}
export type UndoResult =
  // changeSets: the one asked for, then every dependent undone with it.
  | { status: 'undone'; changeSets: ChangeSet[]; version: number }
  // 'changed-since': a value was changed outside the ledger after the change set wrote it.
  | { status: 'blocked'; reason: 'has-dependents' | 'changed-since' | 'nothing-to-undo'; blockedBy: string[]; version: number }

// The catalog read model (plan phase A1b): a projection of assets, observations, user
// decisions and applied change sets, kept up to date in the transaction that changes them.
// What a provider calls an album or a track. Newest link first.
export type CatalogLink = { sourceId: string; externalId: string }
export type CatalogTrack = {
  id: string // the occurrence ID
  albumId: string
  assetId: string
  position: number
  disc?: number
  track?: number
  title?: string
  artist?: string
  duration?: number
  availability: Availability
  links: CatalogLink[]
}
export type CatalogAlbum = {
  id: string
  title?: string
  artist?: string
  year?: number
  genre?: string
  favorite: boolean
  availability: Availability | 'partial'
  traits: TraitValues
  locks: string[] // locked fields, sorted
  links: CatalogLink[]
  addedAt: number // when the anchor was created
  trackCount: number
  version: number // the catalog version at which this album last changed
}
export type CatalogAlbumDetail = CatalogAlbum & { tracks: CatalogTrack[] }
export type CatalogArtist = { name: string; albumCount: number }
export type CatalogSort = 'artist' | 'title' | 'added'
export type CatalogSearchKind = 'album' | 'artist' | 'track'
export type ProjectionReport = { albums: number; tracks: number; version: number; ms: number }
export type ProjectionCheck = { consistent: boolean; albums: number; differing: string[] }

export type CatalogErrorCode =
  | 'invalid-request' | 'invalid-source' | 'source-identity-immutable' | 'unknown-source' | 'unknown-subject'
  | 'unknown-observation' | 'model-cannot-link' | 'link-conflict' | 'unknown-change-set' | 'change-set-conflict'

// Requests and responses are plain JSON. A failure rejects with an Error whose
// message starts with a CatalogErrorCode followed by ':'.
export interface CatalogService {
  registerSource(source: SourceInput): Promise<CatalogSource> // creates or updates label and policy
  listSources(): Promise<{ sources: CatalogSource[] }>
  ingestScan(snapshot: ScanSnapshot): Promise<ScanResult>
  linkProvider(request: { sourceId: string; kind: 'album' | 'track'; externalId: string; subject: EntityRef; linkedAt: number }): Promise<ProviderLink>
  resolveProviderId(request: { sourceId: string; kind: 'album' | 'track'; externalId: string }): Promise<{ subject?: EntityRef }>
  recordObservation(observation: ObservationInput): Promise<Observation>
  recordUserDecision(decision: UserDecisionInput): Promise<UserDecision>
  getAlbum(request: { albumId: string }): Promise<{ album?: AlbumView }>
  getAsset(request: { assetId: string }): Promise<{ asset?: AssetView }>
  getPlaybackLinks(request: { assetIds: string[] }): Promise<{ links: Record<string, CatalogLink[]>; version: number }>
  listAlbums(request: { offset?: number; limit?: number }): Promise<{ albums: AlbumView[]; total: number }>
  getConsent(): Promise<ConsentRecord>
  setConsent(request: { consent: ConsentKey; value: 'granted' | 'denied'; decidedAt: number }): Promise<ConsentRecord>
  // The ledger. A malformed request rejects. A change the rules refuse resolves as 'rejected'.
  commitChangeSet(input: ChangeSetInput): Promise<CommitResult>
  undoChangeSet(request: UndoRequest): Promise<UndoResult>
  // Undoes the newest applied operation that wrote the field.
  undoField(request: { subject: EntityRef; field: string; cascade?: boolean; undoneAt: number }): Promise<UndoResult>
  getChangeSet(request: { id: string }): Promise<{ changeSet?: ChangeSet }>
  // Newest first.
  listChangeSets(request: { offset?: number; limit?: number }): Promise<{ changeSets: ChangeSet[]; total: number; version: number }>
  // The read model. Albums with no track are not listed.
  listCatalogAlbums(request: { offset?: number; limit?: number; sort?: CatalogSort; artist?: string }): Promise<{ albums: CatalogAlbum[]; total: number; version: number }>
  getCatalogAlbum(request: { albumId: string }): Promise<{ album?: CatalogAlbumDetail; version: number }>
  // Every word of the query must start a word of the title or the artist. Case and accents are ignored.
  searchCatalog(request: { query: string; kinds?: CatalogSearchKind[]; limit?: number; offset?: number }): Promise<{ albums: CatalogAlbum[]; artists: CatalogArtist[]; tracks: CatalogTrack[]; version: number }>
  rebuildProjections(): Promise<ProjectionReport>
  // Compares the stored projections with a full rebuild, without changing them.
  verifyProjections(): Promise<ProjectionCheck>
}

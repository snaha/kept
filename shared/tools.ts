// C0 tool contracts: the typed inputs and outputs of the deterministic tools. The UI
// calls the tools directly and an optional LLM drives the same ones through the
// descriptors in tool-contracts.js. A result holds catalog IDs and scores only:
// never a path, audio, lyrics or any other text.
import type { CatalogAlbum, TraitName } from './catalog'

export type ToolName = 'search_catalog' | 'find_similar' | 'rank_tracks' | 'build_queue'
// An album anchor ID, or the ID of a track occurrence in an album.
export type ToolRef = { kind: 'album' | 'track'; id: string }
export type ScoredRef = { ref: ToolRef; score: number } // score is 0..1, best first
export type TraitTargets = Partial<Record<TraitName, number>> // 0..100, as in Dig
export type TraitRange = { min?: number; max?: number }
// What a result rests on: 'sound' features, hand-set or estimated 'traits', or 'metadata'.
export type SimilarityBasis = 'sound' | 'traits' | 'metadata'

export type SearchCatalogInput = {
  query: string
  kinds?: ToolRef['kind'][] // both when absent
  favorite?: boolean
  traits?: Partial<Record<TraitName, TraitRange>>
  limit?: number
}
export type SearchCatalogOutput = { results: ScoredRef[] }

export type FindSimilarInput = {
  seed: ToolRef
  kind?: ToolRef['kind'] // the seed's kind when absent
  novelty?: number // 0 keeps to what the user plays, 1 prefers what they have not played
  excludeSeedArtist?: boolean
  limit?: number
}
export type FindSimilarOutput = { results: (ScoredRef & { basis: SimilarityBasis })[] }

export type RankTracksInput = {
  occurrenceIds: string[]
  traits?: TraitTargets
  similarTo?: ToolRef
  novelty?: number
  limit?: number
}
export type RankTracksOutput = { ranked: { occurrenceId: string; score: number }[] }

export type BuildQueueInput = {
  seeds: ToolRef[]
  length: number
  traits?: TraitTargets
  novelty?: number
  maxPerAlbum?: number
}
export type BuildQueueOutput = { occurrenceIds: string[] }

export type ToolIo = {
  search_catalog: { input: SearchCatalogInput; output: SearchCatalogOutput }
  find_similar: { input: FindSimilarInput; output: FindSimilarOutput }
  rank_tracks: { input: RankTracksInput; output: RankTracksOutput }
  build_queue: { input: BuildQueueInput; output: BuildQueueOutput }
}
export type ToolHandlers = { [Name in ToolName]: (input: ToolIo[Name]['input']) => Promise<ToolIo[Name]['output']> }

// The subset of JSON Schema the descriptors use. Objects are closed: a key that is
// not listed is an error.
export type ToolSchema =
  | { type: 'string'; description?: string; enum?: readonly string[]; pattern?: string; minLength?: number; maxLength?: number }
  | { type: 'number' | 'integer'; description?: string; minimum?: number; maximum?: number }
  | { type: 'boolean'; description?: string }
  | { type: 'array'; description?: string; items: ToolSchema; minItems?: number; maxItems?: number }
  | { type: 'object'; description?: string; properties: Record<string, ToolSchema>; required?: readonly string[]; additionalProperties: false }
export type ToolContract<Name extends ToolName = ToolName> = { name: Name; description: string; input: ToolSchema; output: ToolSchema }

// C1: what the deterministic tools read besides the catalog. Both are injected, so the
// tools are tested on fakes and B1's features.sqlite store implements FeatureSource.
export type FeatureMethod = { id: string; version: string }
export type FeatureVector = ArrayLike<number>
// Embeddings of one method and version. Albums are keyed by catalog album ID and tracks by
// asset ID. An ID with no vector is absent from the map.
export interface FeatureSource {
  readonly method: FeatureMethod
  albumVectors(albumIds: string[]): Promise<Map<string, FeatureVector>>
  trackVectors(assetIds: string[]): Promise<Map<string, FeatureVector>>
}
// Plays per catalog album ID (the provider IDs of the listening history already mapped).
export type HistoryStats = {
  albumStats(albums: ReadonlyMap<string, CatalogAlbum>): Promise<Record<string, { plays: number; lastPlayed: number }>>
}
// dropped counts IDs that were not in the catalog and so were left out of the output.
export type ToolRun<Name extends ToolName = ToolName> = { name: Name; output: ToolIo[Name]['output']; dropped: number }
export type ToolRunRequest = { [Name in ToolName]: { name: Name; input: ToolIo[Name]['input'] } }[ToolName]

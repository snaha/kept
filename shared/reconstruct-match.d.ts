export const ASSIGNMENT_POLICY: string
export const RELEASE_POLICY: string
export const TITLE_MIN: number
export const PAIR_MIN: number
export const PAIR_MARGIN: number
export const MIN_MATCHED: number
export const MIN_COVERAGE: number
export const NAME_SIMILARITY: number
export const GROUP_MARGIN: number

export type LocalTrack = { id: string; title?: string; duration?: number; track?: number; disc?: number; recordingId?: string }
export type ReleaseSlot = { disc: number; position: number; title: string; duration?: number; recordingId?: string }
// What Kept keeps of a MusicBrainz release: core data only.
export type ProviderRelease = {
  id: string
  title: string
  artist: string
  date?: string
  status?: string
  releaseGroupId?: string
  firstReleaseDate?: string
  media: { position: number; tracks: { position: number; title: string; length: number; recordingId?: string }[] }[]
}
export type TrackPair = { id: string; slot: number; score: number; margin: number; ambiguous: boolean }
export type Assignment = { policy: string; pairs: TrackPair[]; unmatched: string[]; unused: number[] }
export type ReleaseVeto = 'too-few-tracks' | 'coverage' | 'ambiguous-tracks' | 'artist' | 'title' | 'completeness'
export type ReleaseEvaluation = {
  policy: string
  release: ProviderRelease
  slots: ReleaseSlot[]
  assignment: Assignment
  matched: number
  files: number
  coverage: number
  completeness: number
  mean: number
  titleFit: number
  artistFit?: number
  accepted: boolean
  vetoes: ReleaseVeto[]
}
export type ReleaseChoice =
  | { status: 'no-match'; candidates: number }
  | { status: 'ambiguous'; candidates: number; releases: string[] }
  | { status: 'matched'; best: ReleaseEvaluation; editions: ReleaseEvaluation[]; candidates: number }

export function norm(text: unknown): string
export function squash(text: unknown): string
export function known(text: unknown): text is string
export function isVarious(text: unknown): boolean
export function primaryCredit(text: unknown): string
export function cleanTitle(text: unknown): string | undefined
export function discOfTitle(text: unknown): { title: string; disc: number } | undefined
export function discOfFolder(name: string | undefined): number | undefined
export function parseFileName(file: string): { track?: number; stem: string }
export function versionWords(text: unknown): string
export function similarity(a: unknown, b: unknown, cut?: boolean): number
export function sameArtist(a: unknown, b: unknown): boolean
export function hungarian(cost: number[][]): number[]
export function pairScore(local: LocalTrack, slot: ReleaseSlot): number | undefined
export function assignTracks(locals: LocalTrack[], slots: ReleaseSlot[]): Assignment
export function releaseSlots(release: ProviderRelease): ReleaseSlot[]
export function evaluateRelease(target: { title?: string; artist?: string; tracks: LocalTrack[] }, release: ProviderRelease): ReleaseEvaluation
export function chooseRelease(evaluations: ReleaseEvaluation[]): ReleaseChoice

import type {
  CatalogChange, CatalogChangeKind, CatalogErrorCode, CatalogSource, ChangeOperationKind, ChangeVerdict, ConsentKey, ConsentRecord,
  EvidenceClass, LicenceId, RouteOutcome, SourceConsentState, SourceInput, SourceKind, SourceNetwork, TraitName,
} from './catalog'

export const EVIDENCE_CLASSES: readonly EvidenceClass[]
export const APPROVING_CLASSES: readonly EvidenceClass[]
export const SOURCE_KINDS: readonly SourceKind[]
export const SOURCE_NETWORKS: readonly SourceNetwork[]
export const LICENCE_ORDER: readonly LicenceId[]
export const CONSENT_KEYS: readonly ConsentKey[]
export const TRAIT_NAMES: readonly TraitName[]
export const TRAIT_MIN: number
export const TRAIT_MAX: number
export const TRAIT_FIELD_PREFIX: string
export const CHANGE_KINDS: readonly CatalogChangeKind[]
export const CHANGE_OPERATION_KINDS: readonly ChangeOperationKind[]
export const MEMBERSHIP_LOCK_FIELD: string
export const LINKS_LOCK_FIELD: string
export const FAVORITE_FIELD: string
export const MAX_ID_LENGTH: number
export const ID_PATTERN: RegExp
export const USER_SOURCE_ID: string
export const USER_SOURCE: SourceInput
export function isCatalogId(value: unknown): value is string
export function traitField(name: TraitName): string
export function traitOfField(field: unknown): TraitName | undefined
export function isTraitValue(value: unknown): value is number
export function catalogError(code: CatalogErrorCode, detail: string): Error & { code: CatalogErrorCode }
export function propagateLicence(licences: readonly string[]): LicenceId
export function licenceAllowsCommercialUse(licence: string): boolean
export function propagateEvidenceClass(own: EvidenceClass, inputs: readonly EvidenceClass[]): EvidenceClass
export function validateCatalogChange(change: Pick<CatalogChange, 'evidence'>): ChangeVerdict
export function validateSource<T extends SourceInput>(source: T): T
export function sourceConsentState(source: SourceInput, consents: Partial<ConsentRecord>): SourceConsentState
export function routeSource(source: CatalogSource): RouteOutcome

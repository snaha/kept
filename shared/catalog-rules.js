// Executable rules of the identity spine. Pure functions, shared by the fake
// catalog service, the SQLite service and the frontend. Types: catalog-rules.d.ts.

export const EVIDENCE_CLASSES = ['deterministic', 'user', 'model']
export const APPROVING_CLASSES = ['deterministic', 'user']
export const SOURCE_KINDS = ['local-folder', 'navidrome', 'musicbrainz', 'acoustid', 'cover-art-archive', 'lrclib', 'user', 'model', 'spotify']
export const SOURCE_NETWORKS = ['none', 'lan', 'internet']
// Least restrictive first. A derived value takes the last of its inputs in this order.
export const LICENCE_ORDER = ['user', 'CC0-1.0', 'MIT', 'CC-BY-4.0', 'non-commercial', 'CC-BY-NC-SA-3.0', 'unknown', 'proprietary']
const UNKNOWN_LICENCE = 'unknown'
const FIRST_NON_COMMERCIAL = LICENCE_ORDER.indexOf('non-commercial')
export const CONSENT_KEYS = ['online-lookups', 'acoustid', 'spotify']
export const TRAIT_NAMES = ['mood', 'energy', 'acoustic', 'vocal']
export const TRAIT_MIN = 0
export const TRAIT_MAX = 100
export const TRAIT_FIELD_PREFIX = 'trait.'
export const CHANGE_KINDS = ['merge', 'split', 'rename', 'set-field']
export const CHANGE_OPERATION_KINDS = ['set-field', 'lock-field', 'merge-albums', 'split-album', 'move-track', 'relink-provider']
// Locking these fields of a subject locks its album membership and its provider links.
export const MEMBERSHIP_LOCK_FIELD = 'tracks'
export const LINKS_LOCK_FIELD = 'links'
// A set-field on this field of a subject is the user's favourite decision.
export const FAVORITE_FIELD = 'favorite'
export const MAX_ID_LENGTH = 256
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/
export const USER_SOURCE_ID = 'user'
// Present in every catalog service without being registered.
export const USER_SOURCE = {
  id: USER_SOURCE_ID, kind: 'user', label: 'You', evidenceClass: 'user', licence: 'user',
  policy: { analysisAllowed: false, network: 'none' },
}

export const isCatalogId = value => typeof value === 'string' && value.length <= MAX_ID_LENGTH && ID_PATTERN.test(value)
export const traitField = name => `${TRAIT_FIELD_PREFIX}${name}`
export const traitOfField = field => {
  const name = typeof field === 'string' && field.startsWith(TRAIT_FIELD_PREFIX) ? field.slice(TRAIT_FIELD_PREFIX.length) : undefined
  return TRAIT_NAMES.includes(name) ? name : undefined
}
export const isTraitValue = value => typeof value === 'number' && Number.isFinite(value) && value >= TRAIT_MIN && value <= TRAIT_MAX

export function catalogError(code, detail) {
  const error = new Error(`${code}: ${detail}`)
  error.code = code
  return error
}

const restrictiveness = licence => {
  const index = LICENCE_ORDER.indexOf(licence)
  return index < 0 ? LICENCE_ORDER.indexOf(UNKNOWN_LICENCE) : index
}

// Licence propagation: the most restrictive licence of the inputs. An unrecognised
// licence counts as 'unknown', and so does an empty input list.
export function propagateLicence(licences) {
  if (!licences.length) return UNKNOWN_LICENCE
  return LICENCE_ORDER[Math.max(...licences.map(restrictiveness))]
}

export const licenceAllowsCommercialUse = licence => restrictiveness(licence) < FIRST_NON_COMMERCIAL

// A value computed from any model input is model evidence, whoever computed it.
export function propagateEvidenceClass(own, inputs) {
  return [own, ...inputs].every(value => APPROVING_CLASSES.includes(value)) ? own : 'model'
}

// The source-class rule. Reads only deterministic and user evidence: model evidence,
// and evidence of an unrecognised class, never approves and never blocks.
// A user rejection blocks. Otherwise user support approves. Otherwise deterministic
// evidence approves when at least one item supports and none contradicts.
export function validateCatalogChange(change) {
  const evidence = change.evidence.filter(item => APPROVING_CLASSES.includes(item.evidenceClass))
  const user = evidence.filter(item => item.evidenceClass === 'user')
  if (user.some(item => item.supports !== true)) return { approvable: false, reason: 'rejected-by-user' }
  if (user.length) return { approvable: true, basis: 'user' }
  if (!evidence.length) return { approvable: false, reason: change.evidence.length ? 'model-only' : 'no-evidence' }
  if (evidence.some(item => item.supports !== true)) return { approvable: false, reason: 'contradicted' }
  return { approvable: true, basis: 'deterministic' }
}

// Throws 'invalid-source' unless the registry entry is well formed and its policy
// is consistent with its kind.
export function validateSource(source) {
  const fail = detail => { throw catalogError('invalid-source', detail) }
  if (!source || typeof source !== 'object') fail('not an object')
  const { policy } = source
  if (!isCatalogId(source.id)) fail('id')
  if (!SOURCE_KINDS.includes(source.kind)) fail('kind')
  if (typeof source.label !== 'string') fail('label')
  if (!EVIDENCE_CLASSES.includes(source.evidenceClass)) fail('evidence class')
  if (!LICENCE_ORDER.includes(source.licence)) fail('licence')
  if (!policy || typeof policy !== 'object' || typeof policy.analysisAllowed !== 'boolean' || !SOURCE_NETWORKS.includes(policy.network)) fail('policy')
  if (policy.consent !== undefined && !CONSENT_KEYS.includes(policy.consent)) fail('consent key')
  if ((source.kind === 'model') !== (source.evidenceClass === 'model')) fail('only model sources give model evidence')
  if ((source.kind === 'user') !== (source.evidenceClass === 'user')) fail('only user sources give user evidence')
  if (source.kind === 'user' && source.id !== USER_SOURCE_ID) fail('the user source is built in')
  if (policy.network === 'internet' && policy.consent === undefined) fail('an internet source needs a consent key')
  if (source.kind === 'spotify' && policy.analysisAllowed) fail('spotify can never be analysed')
  return source
}

export function sourceConsentState(source, consents) {
  return source.policy.consent === undefined ? 'not-required' : consents[source.policy.consent] ?? 'not-asked'
}

// Whether a route may use this source. Only an explicit grant permits a source that needs consent.
export function routeSource(source) {
  const permitted = source.consentState === 'not-required' || source.consentState === 'granted'
  return permitted ? { status: 'permitted' } : { status: 'not-permitted-by-user', consent: source.policy.consent }
}

// C0 tool contracts as data: one descriptor per tool, with a closed JSON schema for
// its input and output, usable as-is as an LLM tool definition. Every string a tool
// may return is a catalog ID, so no result can carry a path, audio or lyrics.
// Types: tools.ts and tool-contracts.d.ts.
import { ID_PATTERN, MAX_ID_LENGTH, TRAIT_MAX, TRAIT_MIN, TRAIT_NAMES } from './catalog-rules.js'

export const TOOL_NAMES = ['search_catalog', 'find_similar', 'rank_tracks', 'build_queue']
export const MAX_TOOL_RESULTS = 200
export const DEFAULT_TOOL_RESULTS = 20
export const MAX_QUERY_LENGTH = 500
export const MAX_RANK_CANDIDATES = 5000
export const MAX_QUEUE_LENGTH = 500
export const MAX_QUEUE_SEEDS = 50
const REF_KINDS = ['album', 'track']
const BASES = ['sound', 'traits', 'metadata']

const object = (properties, required = [], description) => ({ type: 'object', ...(description ? { description } : {}), properties, required, additionalProperties: false })
const list = (items, maxItems, extra = {}) => ({ type: 'array', items, maxItems, ...extra })
const id = description => ({ type: 'string', description, pattern: ID_PATTERN.source, maxLength: MAX_ID_LENGTH })
const unit = description => ({ type: 'number', description, minimum: 0, maximum: 1 })
const trait = description => ({ type: 'number', description, minimum: TRAIT_MIN, maximum: TRAIT_MAX })
const perTrait = (schema, description) => object(Object.fromEntries(TRAIT_NAMES.map(name => [name, schema])), [], description)
const limit = { type: 'integer', description: `Most results to return. ${DEFAULT_TOOL_RESULTS} when absent.`, minimum: 1, maximum: MAX_TOOL_RESULTS }
const kind = description => ({ type: 'string', description, enum: REF_KINDS })
const ref = description => object({ kind: kind('What the ID names.'), id: id('An album ID, or a track occurrence ID.') }, ['kind', 'id'], description)
const score = unit('Relevance, 1 is best.')
const novelty = unit('0 keeps to what the user plays, 1 prefers what they have not played.')
const targets = perTrait(trait('Target value for the trait.'), 'Trait targets. Only the traits an item has are scored.')
const occurrenceId = id('A track occurrence ID.')

export const TOOL_CONTRACTS = {
  search_catalog: {
    name: 'search_catalog',
    description: 'Find albums and tracks in the library by text and by filters.',
    input: object({
      query: { type: 'string', description: 'Words to match in titles, artists and genres. May be empty when filters are given.', maxLength: MAX_QUERY_LENGTH },
      kinds: list(kind('A kind of result.'), REF_KINDS.length, { description: 'Kinds to return. Both when absent.', minItems: 1 }),
      favorite: { type: 'boolean', description: 'Only favourites, or only non-favourites.' },
      traits: perTrait(object({ min: trait('Lowest value.'), max: trait('Highest value.') }), 'Keep items whose trait lies in the range.'),
      limit,
    }, ['query']),
    output: object({ results: list(object({ ref: ref(), score }, ['ref', 'score']), MAX_TOOL_RESULTS) }, ['results']),
  },
  find_similar: {
    name: 'find_similar',
    description: 'Find albums or tracks that sound like a seed album or track.',
    input: object({
      seed: ref('The album or track to start from.'),
      kind: kind('The kind of result. The kind of the seed when absent.'),
      novelty,
      excludeSeedArtist: { type: 'boolean', description: 'Leave out everything by the artist of the seed.' },
      limit,
    }, ['seed']),
    output: object({
      results: list(object({ ref: ref(), score, basis: { type: 'string', description: 'What the match rests on.', enum: BASES } }, ['ref', 'score', 'basis']), MAX_TOOL_RESULTS),
    }, ['results']),
  },
  rank_tracks: {
    name: 'rank_tracks',
    description: 'Order the given tracks by fit to trait targets, to a reference and to novelty.',
    input: object({
      occurrenceIds: list(occurrenceId, MAX_RANK_CANDIDATES, { description: 'The tracks to rank.', minItems: 1 }),
      traits: targets,
      similarTo: ref('Prefer tracks that sound like this album or track.'),
      novelty,
      limit,
    }, ['occurrenceIds']),
    output: object({ ranked: list(object({ occurrenceId, score }, ['occurrenceId', 'score']), MAX_RANK_CANDIDATES) }, ['ranked']),
  },
  build_queue: {
    name: 'build_queue',
    description: 'Build an ordered play queue that starts from seed albums or tracks.',
    input: object({
      seeds: list(ref(), MAX_QUEUE_SEEDS, { description: 'Where the queue starts from.', minItems: 1 }),
      length: { type: 'integer', description: 'Number of tracks wanted.', minimum: 1, maximum: MAX_QUEUE_LENGTH },
      traits: targets,
      novelty,
      maxPerAlbum: { type: 'integer', description: 'Most tracks to take from one album.', minimum: 1, maximum: MAX_QUEUE_LENGTH },
    }, ['seeds', 'length']),
    output: object({ occurrenceIds: list(occurrenceId, MAX_QUEUE_LENGTH) }, ['occurrenceIds']),
  },
}

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const between = (value, min = -Infinity, max = Infinity) => value >= min && value <= max

export function schemaViolation(schema, value, path = 'value') {
  if (schema.type === 'object') {
    if (!isObject(value)) return `${path}: not an object`
    for (const name of schema.required ?? []) if (value[name] === undefined) return `${path}.${name}: missing`
    for (const [name, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties, name)) return `${path}.${name}: not allowed`
      const violation = item === undefined ? undefined : schemaViolation(schema.properties[name], item, `${path}.${name}`)
      if (violation) return violation
    }
    return undefined
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${path}: not a list`
    if (!between(value.length, schema.minItems, schema.maxItems)) return `${path}: wrong length`
    return value.map((item, index) => schemaViolation(schema.items, item, `${path}[${index}]`)).find(Boolean)
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return `${path}: not text`
    if (!between(value.length, schema.minLength, schema.maxLength)) return `${path}: wrong length`
    if (schema.enum && !schema.enum.includes(value)) return `${path}: not one of ${schema.enum.join(', ')}`
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${path}: not an ID`
    return undefined
  }
  if (schema.type === 'boolean') return typeof value === 'boolean' ? undefined : `${path}: not true or false`
  if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) return `${path}: not ${schema.type === 'integer' ? 'a whole number' : 'a number'}`
  return between(value, schema.minimum, schema.maximum) ? undefined : `${path}: out of range`
}

const validate = (name, side, value) => {
  if (!Object.hasOwn(TOOL_CONTRACTS, name)) throw new Error(`Unknown tool ${name}`)
  const violation = schemaViolation(TOOL_CONTRACTS[name][side], value, side)
  if (violation) throw new Error(`Invalid ${name} ${violation}`)
  return value
}
export const validateToolInput = (name, input) => validate(name, 'input', input)
export const validateToolOutput = (name, output) => validate(name, 'output', output)

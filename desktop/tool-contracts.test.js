import test from 'node:test'
import assert from 'node:assert/strict'
import { TOOL_CONTRACTS, TOOL_NAMES, validateToolInput, validateToolOutput } from '../shared/tool-contracts.js'

const LENGTH = 25, ENERGY = 70, TOO_HIGH = 101, SCORE = 0.9
const album = { kind: 'album', id: 'album:1' }
const occurrenceId = 'occurrence:album:1:asset:abc:4096'
const examples = {
  search_catalog: { input: { query: 'blue', kinds: ['album'], favorite: true, traits: { energy: { min: ENERGY } }, limit: LENGTH }, output: { results: [{ ref: album, score: SCORE }] } },
  find_similar: { input: { seed: album, novelty: 1, excludeSeedArtist: true }, output: { results: [{ ref: { kind: 'track', id: occurrenceId }, score: SCORE, basis: 'sound' }] } },
  rank_tracks: { input: { occurrenceIds: [occurrenceId], traits: { energy: ENERGY }, similarTo: album }, output: { ranked: [{ occurrenceId, score: SCORE }] } },
  build_queue: { input: { seeds: [album], length: LENGTH, maxPerAlbum: 2 }, output: { occurrenceIds: [occurrenceId] } },
}

// Every schema node, so the checks below cover nested results too.
const nodes = schema => [schema, ...(schema.items ? nodes(schema.items) : []), ...Object.values(schema.properties ?? {}).flatMap(nodes)]

test('every tool has a descriptor an LLM can be given as it is', () => {
  assert.deepEqual(Object.keys(TOOL_CONTRACTS), TOOL_NAMES)
  for (const name of TOOL_NAMES) {
    const contract = TOOL_CONTRACTS[name]
    assert.equal(contract.name, name)
    assert.ok(contract.description)
    assert.deepEqual(JSON.parse(JSON.stringify(contract)), contract)
    for (const node of [...nodes(contract.input), ...nodes(contract.output)]) if (node.type === 'object') assert.equal(node.additionalProperties, false)
    assert.equal(validateToolInput(name, examples[name].input), examples[name].input)
    assert.equal(validateToolOutput(name, examples[name].output), examples[name].output)
  }
})

test('tool results can hold IDs and scores only', () => {
  for (const name of TOOL_NAMES) {
    for (const node of nodes(TOOL_CONTRACTS[name].output)) if (node.type === 'string') assert.ok(node.enum || node.pattern, `${name} returns free text`)
  }
  assert.throws(() => validateToolOutput('build_queue', { occurrenceIds: ['/Users/me/Music/one.flac'] }), /not an ID/)
  assert.throws(() => validateToolOutput('build_queue', { occurrenceIds: ['a line of a lyric'] }), /not an ID/)
  assert.throws(() => validateToolOutput('search_catalog', { results: [{ ref: album, score: SCORE, path: 'one.flac' }] }), /path: not allowed/)
  assert.throws(() => validateToolOutput('find_similar', { results: [{ ref: { ...album, title: 'Blue' }, score: SCORE, basis: 'sound' }] }), /title: not allowed/)
  assert.throws(() => validateToolOutput('rank_tracks', { ranked: [{ occurrenceId, score: SCORE, lyrics: 'la' }] }), /lyrics: not allowed/)
})

test('tool inputs are bounded and closed', () => {
  assert.throws(() => validateToolInput('play_everything', {}), /Unknown tool/)
  assert.throws(() => validateToolInput('search_catalog', {}), /query: missing/)
  assert.throws(() => validateToolInput('search_catalog', { query: 'x', limit: 0 }), /limit: out of range/)
  assert.throws(() => validateToolInput('search_catalog', { query: 'x', traits: { energy: { max: TOO_HIGH } } }), /max: out of range/)
  assert.throws(() => validateToolInput('search_catalog', { query: 'x', traits: { tempo: {} } }), /tempo: not allowed/)
  assert.throws(() => validateToolInput('find_similar', { seed: { kind: 'artist', id: 'a' } }), /kind: not one of/)
  assert.throws(() => validateToolInput('rank_tracks', { occurrenceIds: [] }), /wrong length/)
  assert.throws(() => validateToolInput('build_queue', { seeds: [album], length: 1.5 }), /whole number/)
  assert.throws(() => validateToolInput('build_queue', { seeds: [album], length: LENGTH, shell: 'rm' }), /shell: not allowed/)
})

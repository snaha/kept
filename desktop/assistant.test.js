import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TOOL_CONTRACTS, TOOL_NAMES } from '../shared/tool-contracts.js'
import { createToolRunner } from '../shared/tool-runner.js'
import { createAssistant, MAX_TURNS, SYSTEM_PROMPT, TOOLS } from './assistant.js'
import { ALBUMS, createAssistantWorld } from './assistant-fixture.js'
import { EVAL_CASES, checkTrace, createScriptedModel, resolvePlaceholders, runEval } from './assistant-eval.js'
import { assertPrivatePayload, findPrivacyViolations } from './assistant-privacy.js'
import { createProvider, DEFAULT_ANTHROPIC_MODEL } from './assistant-providers.js'
import { createAssistantService } from './assistant-service.js'
import { createAssistantSettings } from './assistant-settings.js'
import { CatalogDatabase } from './catalog-database.js'

const KEY = 'sk-ant-test-0123456789'
const MIN_PAYLOADS = 3
const world = await createAssistantWorld()
const assistant = createAssistant({ runner: world.runner })
const privacy = { folders: [world.folder] }
const traceOf = async (provider, prompt) => assistant.ask({ request: prompt, provider }).then(({ message, queue, calls }) => ({ message, queue, calls }))
const FIXTURE_SOURCE = { id: 'fixture-folder', kind: 'local-folder', label: 'Fixture', evidenceClass: 'deterministic', licence: 'user', policy: { analysisAllowed: true, network: 'none' } }
const FIXTURE_PROVIDER = { id: 'fixture-navidrome', kind: 'navidrome', label: 'Fixture', evidenceClass: 'deterministic', licence: 'user', policy: { analysisAllowed: true, network: 'lan' } }
const FIRST_SCAN = 1000
const FIXTURE_SIZE = 4096

async function openFixtureCatalog(t) {
  const database = new CatalogDatabase(':memory:')
  t.after(() => database.close())
  const catalog = database.service
  await catalog.registerSource(FIXTURE_SOURCE)
  await catalog.registerSource(FIXTURE_PROVIDER)
  return catalog
}

async function scanTracks(catalog, titles, observedAt) {
  const artist = ALBUMS.needlewalk.artist
  await catalog.ingestScan({
    sourceId: FIXTURE_SOURCE.id, providerSourceId: FIXTURE_PROVIDER.id, observedAt, rootAvailable: true, complete: true,
    files: titles.map((title, index) => ({
      path: `Fixture Collection/${index}/tone.flac`, contentHash: `fixture-hash-${index}`, size: FIXTURE_SIZE,
      providerTrackId: `fixture-track-${index}`, providerAlbumId: `fixture-album-${index}`,
      track: 1, tags: { title, artist, album: `Zoveki Fixture ${index}` },
    })),
  })
}

// A fake HTTP endpoint that answers from a script and keeps every body it was sent.
function scriptedEndpoint(kind, turns) {
  const bodies = []
  const headers = []
  const urls = []
  let index = 0
  const fetch = async (url, init) => {
    urls.push(String(url))
    bodies.push(String(init.body))
    headers.push(init.headers)
    const turn = turns[index++]
    const blocks = [
      ...(turn.text ? [{ type: 'text', text: turn.text }] : []),
      ...(turn.calls ?? []).map((call, position) => ({ type: 'tool_use', id: `toolu_${index}_${position}`, name: call.name, input: resolvePlaceholders(call.input, world) })),
    ]
    const reply = kind === 'anthropic'
      ? { id: `msg_${index}`, type: 'message', role: 'assistant', model: DEFAULT_ANTHROPIC_MODEL, content: blocks, stop_reason: turn.calls?.length ? 'tool_use' : 'end_turn', stop_sequence: undefined, usage: { input_tokens: 1, output_tokens: 1 } }
      : { choices: [{ message: { role: 'assistant', content: turn.text ?? '', tool_calls: blocks.filter(block => block.type === 'tool_use').map(block => ({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } })) } }] }
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetch, bodies, headers, urls }
}

test('the scripted evaluation set meets every expectation, and the checker is not vacuous', async () => {
  assert.ok(EVAL_CASES.length >= 15)
  const results = await runEval((prompt, testCase) => traceOf(createScriptedModel(testCase.script, world), prompt), world)
  assert.deepEqual(results.filter(result => !result.passed), [])
  // A model that picks a different shape fails the same expectations.
  const calm = EVAL_CASES.find(item => item.id === 'calm-unplayed')
  const lazy = [{ calls: [{ name: 'search_catalog', input: { query: 'calm' } }] }, { calls: [{ name: 'build_queue', input: { seeds: ['$ref:album:stillwater'], length: 10, novelty: 0.1 } }] }, { text: 'Done.' }]
  assert.ok(checkTrace(resolvePlaceholders(calm.expect, world), await traceOf(createScriptedModel(lazy, world), calm.prompt)).length >= 2)
  const missing = EVAL_CASES.find(item => item.id === 'live-missing')
  const substitutes = [{ calls: [{ name: 'search_catalog', input: { query: 'blue' } }] }, { calls: [{ name: 'build_queue', input: { seeds: ['$ref:album:blue'], length: 5 } }] }, { text: 'Here is Blue.' }]
  const failures = checkTrace(missing.expect, await traceOf(createScriptedModel(substitutes, world), missing.prompt))
  assert.ok(failures.includes('called build_queue'))
  const rejected = await traceOf(createScriptedModel(substitutes, world), missing.prompt)
  assert.deepEqual(rejected.queue, [])
  assert.equal(rejected.message, 'No tracks fit your request.')
})

test('the ambiguous name search gives the model both invented artists to clarify', async () => {
  const scenario = EVAL_CASES.find(item => item.id === 'ambiguous-artist')
  const scripted = createScriptedModel(scenario.script, world)
  const candidates = []
  const provider = {
    complete(args) {
      for (const item of args.messages.at(-1).content.filter(block => block.type === 'tool_result')) {
        candidates.push(...JSON.parse(item.content).results)
      }
      return scripted.complete(args)
    },
  }
  const { queue, message } = await traceOf(provider, scenario.prompt)
  const expected = ['needlewalk', 'plumeclock']
  assert.deepEqual(new Set(candidates.map(({ ref }) => ref.id)), new Set(expected.map(key => world.ids[key])))
  assert.ok(expected.every(key => message.includes(ALBUMS[key].artist)))
  assert.deepEqual(queue, [])
})

test('the scripted library summary names the artists returned by catalog search', async () => {
  const scenario = EVAL_CASES.find(item => item.id === 'whats-in-library')
  const script = createScriptedModel(scenario.script, world)
  const artists = new Set()
  const provider = {
    complete(args) {
      for (const item of args.messages.at(-1).content.filter(block => block.type === 'tool_result')) {
        for (const { artist } of JSON.parse(item.content).results) artists.add(artist)
      }
      return script.complete(args)
    },
  }
  const { message } = await traceOf(provider, scenario.prompt)
  const named = message.replace(/^Albums by |\.$/g, '').split(/, | and /)
  assert.ok(artists.size > 0)
  assert.deepEqual(new Set(named), artists)
})

test('an exact artist queue reports a shortfall instead of padding it with similar artists', async () => {
  const { artist } = ALBUMS.stillwater
  const matching = [...world.tracks.stillwater, ...world.tracks.slowtide]
  const length = matching.length + 1
  const provider = createScriptedModel([
    { calls: [{ name: 'build_queue', input: { seeds: ['$ref:album:stillwater'], length } }] },
    { text: `Here are ${length} tracks.` },
  ], world)
  const result = await traceOf(provider, `${length} tracks by "${artist}"`)
  assert.deepEqual(new Set(result.queue.map(item => item.occurrenceId)), new Set(matching))
  assert.equal(result.message, `Only ${matching.length} of ${length} requested tracks fit your request.`)
})

test('ranking an exact named track discards other recordings even if the model includes them', async () => {
  const { tracks } = world
  const [selected, other] = tracks.needlewalk
  const title = `${ALBUMS.needlewalk.title} 1`
  const provider = createScriptedModel([
    { calls: [{ name: 'rank_tracks', input: { occurrenceIds: [other, selected] } }] },
    { text: 'Here is the recording.' },
  ], world)
  const result = await traceOf(provider, `Play the track "${title}"`)
  assert.deepEqual(result.queue.map(item => item.occurrenceId), [selected])
})

test('a queue for tracks from a named artist fills only from that artist', async () => {
  const { artist } = ALBUMS.needlewalk
  const outsider = world.tracks.plumeclock[0]
  const provider = createScriptedModel([
    { calls: [{ name: 'build_queue', input: { seeds: [{ kind: 'track', id: outsider }], length: 2 } }] },
    { text: 'Here are two tracks.' },
  ], world)
  const { queue } = await traceOf(provider, `two tracks from ${artist}`)
  assert.equal(queue.length, 2)
  assert.ok(queue.every(item => world.tracks.needlewalk.includes(item.occurrenceId)))
})

test('a request for two artists allows either exact credit', async () => {
  const [first, second] = [world.tracks.needlewalk[0], world.tracks.plumeclock[0]]
  const provider = createScriptedModel([
    { calls: [{ name: 'rank_tracks', input: { occurrenceIds: [world.tracks.latehours[0], first, second] } }] },
    { text: 'Here are two tracks.' },
  ], world)
  const { queue } = await traceOf(provider, `two tracks by "${ALBUMS.needlewalk.artist}" and ${ALBUMS.plumeclock.artist}`)
  assert.deepEqual(queue.map(item => item.occurrenceId), [first, second])
})

test('a quoted track title containing by selects that occurrence', async t => {
  const catalog = await openFixtureCatalog(t)
  const title = 'Zoveki by Lanternlight'
  await scanTracks(catalog, [title, 'Zoveki Shimmers'], FIRST_SCAN)
  const { tracks: [selected] } = await catalog.searchCatalog({ query: title, kinds: ['track'] })
  const { tracks: [other] } = await catalog.searchCatalog({ query: 'Zoveki Shimmers', kinds: ['track'] })
  const assistant = createAssistant({ runner: createToolRunner({ catalog }) })
  const script = [
    { calls: [{ name: 'rank_tracks', input: { occurrenceIds: [other.id, selected.id] } }] },
    { text: 'Here is the recording.' },
  ]
  for (const request of [`Play the track "${title}"`, `Play the track “${title}” by ${ALBUMS.needlewalk.artist}`]) {
    const { queue } = await assistant.ask({ request, provider: createScriptedModel(script, world) })
    assert.deepEqual(queue.map(item => item.occurrenceId), [selected.id], request)
  }
})

test('a scan between model turns keeps queue constraints and labels current', async t => {
  const catalog = await openFixtureCatalog(t)
  const originalTitle = 'Zoveki Shimmers'
  const addedTitle = 'Zoveki Lanternlight'
  await scanTracks(catalog, [originalTitle], FIRST_SCAN)
  const { tracks: [original] } = await catalog.searchCatalog({ query: originalTitle, kinds: ['track'] })
  const assistant = createAssistant({ runner: createToolRunner({ catalog }) })
  const artist = ALBUMS.needlewalk.artist
  const rank = occurrenceIds => ({ name: 'rank_tracks', input: { occurrenceIds } })
  const search = { name: 'search_catalog', input: { query: addedTitle, kinds: ['track'] } }
  const script = createScriptedModel([
    { calls: [rank([original.id])] }, { calls: [search] },
  ], world)
  let addedId
  let turns = 0
  const provider = {
    async complete(args) {
      turns++
      if (turns === 1) return script.complete(args)
      const [result] = args.messages.at(-1).content
      if (turns === 2) {
        assert.equal(JSON.parse(result.content).ranked[0].title, originalTitle)
        await scanTracks(catalog, [originalTitle, addedTitle], FIRST_SCAN + 1)
        return script.complete(args)
      }
      if (!addedId) {
        const [hit] = JSON.parse(result.content).results
        assert.equal(hit.title, addedTitle)
        addedId = hit.ref.id
        return { content: [{ type: 'tool_use', id: 'rank-new', ...rank([addedId]) }], stop: 'tool_use' }
      }
      assert.equal(JSON.parse(result.content).ranked[0].title, addedTitle)
      return { content: [{ type: 'text', text: 'Here is the recording.' }], stop: 'end' }
    },
  }
  const { queue } = await assistant.ask({ request: `one track by ${artist}`, provider })
  assert.deepEqual(queue.map(item => [item.occurrenceId, item.title, item.artist]), [[addedId, addedTitle, artist]])
})

test('the model only picks tools; the queue is the runner output, in real occurrence IDs', async () => {
  const model = createScriptedModel([
    { calls: [{ name: 'search_catalog', input: { query: 'marlow', kinds: ['album'] } }] },
    { calls: [{ name: 'build_queue', input: { seeds: ['$ref:album:stillwater'], length: 6 } }] },
    { text: 'Here is a queue. (Fake track IDs: occurrence:made:up)' },
  ], world)
  const result = await assistant.ask({ request: 'marlow please', provider: model })
  assert.equal(result.queue.length, 6)
  const known = new Set(Object.values(world.tracks).flat())
  assert.ok(result.queue.every(item => known.has(item.occurrenceId) && item.albumId && item.title && item.artist))
  assert.deepEqual(result.steps.map(step => step.tool), ['search_catalog', 'build_queue'])
  assert.ok(!JSON.stringify(result).includes('made:up') || result.message.includes('made:up'), 'model text never becomes a queue entry')
})

test('a candidate found in a search does not become a queue when the model stops without selecting it', async () => {
  const provider = createScriptedModel([
    { calls: [{ name: 'search_catalog', input: { query: '', kinds: ['track'], limit: 1 } }] },
    { text: 'There is no live take in the library.' },
  ], world)
  const result = await assistant.ask({ request: 'Play the live take', provider })
  assert.deepEqual(result.steps, [{ tool: 'search_catalog', ok: true, detail: '1 result' }])
  assert.equal(result.message, 'There is no live take in the library.')
  assert.deepEqual(result.queue, [])
})

test('a tool error is shown plainly, given back to the model, and does not stop the run', async () => {
  const seen = []
  const model = {
    async complete({ messages }) {
      seen.push(messages.at(-1))
      if (seen.length === 1) return { content: [{ type: 'tool_use', id: 't1', name: 'build_queue', input: { seeds: [{ kind: 'album', id: world.ids.stillwater }], length: 0 } }, { type: 'tool_use', id: 't2', name: 'nope', input: {} }], stop: 'tool_use' }
      return { content: [{ type: 'text', text: 'Sorry, that did not work.' }], stop: 'end' }
    },
  }
  const result = await assistant.ask({ request: 'x', provider: model })
  assert.deepEqual(result.steps.map(step => step.ok), [false, false])
  assert.match(result.steps[0].detail, /Invalid build_queue/)
  assert.match(result.steps[1].detail, /Unknown tool nope/)
  assert.deepEqual(seen[1].content.map(block => [block.tool_use_id, block.is_error]), [['t1', true], ['t2', true]], 'every call is answered, in one message')
  assert.equal(result.queue.length, 0)
})

test('a model that never stops is cut off after a bounded number of turns', async () => {
  let turns = 0
  const model = { complete: async () => { turns++; return { content: [{ type: 'tool_use', id: `t${turns}`, name: 'search_catalog', input: { query: 'blue' } }], stop: 'tool_use' } } }
  await assistant.ask({ request: 'loop', provider: model })
  assert.equal(turns, MAX_TURNS)
})

test('cancelling stops the run before the next model call', async () => {
  const controller = new AbortController()
  let calls = 0
  const model = { complete: async () => { calls++; controller.abort(); return { content: [{ type: 'tool_use', id: 't', name: 'search_catalog', input: { query: 'blue' } }], stop: 'tool_use' } } }
  await assert.rejects(assistant.ask({ request: 'x', provider: model, signal: controller.signal }))
  assert.equal(calls, 1)
})

test('what the model is told: the four tool schemas and a prompt with no location in it', () => {
  assert.deepEqual(TOOLS.map(tool => tool.name), TOOL_NAMES)
  assert.deepEqual(TOOLS.map(tool => tool.input_schema), TOOL_NAMES.map(name => TOOL_CONTRACTS[name].input))
  assert.deepEqual(findPrivacyViolations(SYSTEM_PROMPT + JSON.stringify(TOOLS), privacy), [])
})

for (const kind of ['anthropic', 'local']) {
  test(`${kind}: the transport rejects redirects from the configured model endpoint`, async () => {
    const fetch = async (url, init) => {
      assert.equal(new Request(url, init).redirect, 'error')
      return scriptedEndpoint(kind, [{ text: 'ok' }]).fetch(url, init)
    }
    const provider = createProvider({ provider: kind, apiKey: KEY, baseUrl: 'https://model.example/v1', model: 'fixture-model' }, { fetch, privacy })
    assert.equal((await traceOf(provider, 'choose music')).message, 'ok')
  })

  test(`${kind}: no outbound payload of a scripted session holds a path, the music folder, audio bytes or lyric fields`, async () => {
    const sessions = EVAL_CASES.filter(item => ['calm-unplayed', 'live-exists', 'like-still-water-newer', 'asks-for-path'].includes(item.id))
    const endpoints = []
    for (const testCase of sessions) {
      const endpoint = scriptedEndpoint(kind, testCase.script)
      endpoints.push(endpoint)
      const provider = createProvider({ provider: kind, apiKey: KEY, baseUrl: 'http://localhost:11434/v1', model: kind === 'local' ? 'llama3.1' : DEFAULT_ANTHROPIC_MODEL }, { fetch: endpoint.fetch, privacy })
      const result = await traceOf(provider, testCase.prompt)
      assert.deepEqual(checkTrace(resolvePlaceholders(testCase.expect, world), result), [], testCase.id)
    }
    const bodies = endpoints.flatMap(endpoint => endpoint.bodies)
    assert.ok(bodies.length >= MIN_PAYLOADS * sessions.length / 2, 'the interception saw the session')
    for (const body of bodies) {
      assert.deepEqual(findPrivacyViolations(body, { folders: [world.folder, os.homedir()], extra: ['Collection/', '.flac'] }), [], 'scan')
      // The checks again, spelled out, so a weakening of the scanner cannot hide a leak.
      assert.ok(!/\/Users\/|\/home\/|\/Volumes\/|(?<![A-Za-z0-9])[A-Za-z]:\\[^n]|file:\/\//.test(body), 'no absolute path')
      assert.ok(!body.includes(world.folder) && !body.includes(os.homedir()) && !body.includes('Collection/'), 'no music folder or relative location')
      assert.ok(!/\.(flac|mp3|m4a|wav|ogg)\b/i.test(body) && !/data:audio|"audio"/.test(body) && !/[A-Za-z0-9+/]{200,}/.test(body), 'no audio')
      assert.ok(!/lyric/i.test(body), 'no lyric field or text')
      assert.ok(!body.includes(KEY), 'the key is a header, never part of the body')
    }
    const all = bodies.join('\n')
    assert.ok(all.includes('search_catalog') && all.includes('score') && /Marlow|Gamma Rays/.test(all), 'what is sent: tool names, scores, titles and artist names')
    assert.ok(all.includes(world.ids.stillwater) || all.includes(world.ids.overdrivelive), 'and IDs')
  })
}

test('a request or a tool result that carries a location is refused before it leaves', async () => {
  const endpoint = scriptedEndpoint('anthropic', [{ text: 'hi' }])
  const provider = createProvider({ provider: 'anthropic', apiKey: KEY }, { fetch: endpoint.fetch, privacy })
  await assert.rejects(assistant.ask({ request: `play what is in ${world.folder}/Marlow`, provider }), /Not sent/)
  await assert.rejects(assistant.ask({ request: 'play /Users/someone/Music/a.flac', provider }), /Not sent/)
  assert.equal(endpoint.bodies.length, 0, 'nothing was sent')
  assert.throws(() => assertPrivatePayload(JSON.stringify({ lyrics: 'la la' })), /lyric field/)
  assert.throws(() => assertPrivatePayload('x'.repeat(10) + 'QUJD'.repeat(100)), /audio bytes/)
})

test('the service refuses configured music folders in plain and JSON-escaped requests before sending', async () => {
  const endpoint = scriptedEndpoint('local', [{ text: 'ok' }])
  const folders = ['Fixture Collection 9Q', 'Fixture "Quoted" Collection 9Q']
  const service = createAssistantService({
    settings: { resolve: () => ({ enabled: true, provider: 'local', baseUrl: 'http://localhost:11434/v1', model: 'fixture-model' }) },
    assistant,
    folders: () => folders,
    fetch: endpoint.fetch,
  })
  for (const folder of folders) {
    await assert.rejects(service.ask({ id: folder, request: `Play what is in ${folder}/recordings` }), /^Error: Not sent:.*music folder/)
  }
  assert.deepEqual(endpoint.bodies, [])
})

test('the service refuses an absolute path outside its configured folders before sending', async () => {
  const endpoint = scriptedEndpoint('local', [{ text: 'ok' }])
  const service = createAssistantService({
    settings: { resolve: () => ({ enabled: true, provider: 'local', baseUrl: 'https://model.example/v1', model: 'fixture-model' }) },
    assistant,
    folders: () => ['/fixture-data/collection'],
    fetch: endpoint.fetch,
  })
  for (const request of ['Play /fixture-data', 'Choose /fixture-data/archive', 'Choose /[fixture-data]/archive', 'Choose /(fixture data)/archive']) {
    await assert.rejects(service.ask({ id: 'fixture-request', request }), /Not sent:.*absolute path/)
  }
  assert.deepEqual(endpoint.bodies, [])
})

test('an inline slash in a music title reaches the model', async () => {
  const endpoint = scriptedEndpoint('local', [{ text: 'ok' }])
  const provider = createProvider({ provider: 'local', baseUrl: 'https://model.example/v1', model: 'fixture-model' }, { fetch: endpoint.fetch, privacy })
  const request = 'Play the track "Zoveki /Lanternlight"'
  assert.equal((await traceOf(provider, request)).message, 'ok')
  assert.equal(JSON.parse(endpoint.bodies[0]).messages.find(message => message.role === 'user').content, request)
})

test('the initiating document owns the request through navigation and late completion', async () => {
  const sender = new EventEmitter()
  const otherWindow = new EventEmitter()
  const answer = Promise.withResolvers()
  const service = createAssistantService({
    settings: { resolve: () => ({ enabled: true, provider: 'local', model: 'fixture-model' }) },
    assistant: { ask: ({ signal }) => { answer.signal = signal; return answer.promise } },
  })
  const run = service.ask({ id: 'fixture-request', request: 'choose music' }, sender)
  const cancelled = assert.rejects(run, /Cancelled/)
  service.cancel('fixture-request', otherWindow)
  sender.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
  sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
  assert.equal(answer.signal.aborted, false)
  sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  answer.resolve({ message: 'Late answer', queue: [], steps: [] })
  assert.equal(answer.signal.aborted, true)
  await cancelled
  assert.deepEqual(sender.eventNames(), [])
})

test('the service refuses malformed requests before reading provider settings', async () => {
  const service = createAssistantService({ settings: {}, assistant })
  for (const payload of [undefined, { id: 'fixture-request', request: 1 }, { id: 1, request: 'choose music' }]) {
    await assert.rejects(service.ask(payload), /Invalid assistant request/)
  }
})

test('a lyric field inside JSON tool-result content is refused', () => {
  const body = JSON.stringify({ messages: [{ role: 'tool', content: JSON.stringify({ results: [{ lyrics: 'fixture text' }] }) }] })
  assert.throws(() => assertPrivatePayload(body), /Not sent:.*lyric field/)
})

test('audio paths are refused while a title ending in an audio extension can be sent', () => {
  const title = 'Vellum Signal 9Q.mp3'
  const body = value => JSON.stringify({ messages: [{ role: 'tool', content: JSON.stringify({ title: value }) }] })
  assert.doesNotThrow(() => assertPrivatePayload(body(title)))
  for (const separator of ['/', '\\']) {
    assert.throws(() => assertPrivatePayload(body(`Fixture Collection 9Q${separator}${title}`)), /Not sent:.*audio file path/)
  }
})

test('anthropic requests: the official endpoint, latest Sonnet by default, the four tools, no forced tool choice', async () => {
  const endpoint = scriptedEndpoint('anthropic', [{ text: 'ok' }])
  const previous = process.env.ANTHROPIC_BASE_URL
  process.env.ANTHROPIC_BASE_URL = 'https://model.example'
  try {
    const provider = createProvider({ provider: 'anthropic', apiKey: KEY }, { fetch: endpoint.fetch, privacy })
    await traceOf(provider, 'hello')
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = previous
  }
  assert.equal(new URL(endpoint.urls[0]).origin, 'https://api.anthropic.com')
  const body = JSON.parse(endpoint.bodies[0])
  assert.equal(body.model, 'claude-sonnet-5-5')
  assert.deepEqual(body.tools.map(tool => tool.name), TOOL_NAMES)
  assert.ok(!('tool_choice' in body) && !('temperature' in body) && !('thinking' in body))
  assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }])
})

test('failures are named in plain words, and nothing is thrown away silently', async () => {
  const reply = (status, body) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const ask = (config, fetch) => assistant.ask({ request: 'x', provider: createProvider(config, { fetch, privacy }) })
  const anthropic = { provider: 'anthropic', apiKey: KEY }
  await assert.rejects(ask(anthropic, reply(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })), /API key was not accepted/)
  await assert.rejects(ask({ ...anthropic, model: 'nope' }, reply(404, { type: 'error', error: { type: 'not_found_error', message: 'model: nope' } })), /model "nope" was not found/)
  await assert.rejects(ask(anthropic, async () => { throw new TypeError('fetch failed') }), /Could not reach the Anthropic API/)
  await assert.rejects(ask(anthropic, reply(200, { id: 'm', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: 'refusal', usage: { input_tokens: 1, output_tokens: 1 } })), /declined/)
  const local = { provider: 'local', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' }
  await assert.rejects(ask(local, async () => { throw new TypeError('fetch failed') }), /Could not reach localhost:11434.*server is running/)
  await assert.rejects(ask(local, reply(404, { error: 'model not found' })), /no model "llama3.1"/)
  await assert.rejects(ask(local, reply(200, { nothing: true })), /cannot read/)
  await assert.rejects(assistant.ask({ request: '   ', provider: createScriptedModel([], world) }), /what you would like to hear/)
})

test('settings: off by default, the key is encrypted at rest and never given back', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'kept-assistant-'))
  try {
    const safeStorage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(`enc:${[...text].reverse().join('')}`), decryptString: buffer => [...buffer.toString().slice(4)].reverse().join('') }
    const settings = createAssistantSettings({ directory, safeStorage })
    assert.deepEqual(settings.status(), { enabled: false, provider: 'anthropic', model: 'claude-sonnet-5-5', models: { anthropic: 'claude-sonnet-5-5', local: '' }, baseUrl: 'http://localhost:11434/v1', hasKey: false, canStoreKey: true })
    assert.throws(() => settings.save({ apiKey: KEY }), /which provider/)
    const saved = settings.save({ enabled: true, provider: 'anthropic', apiKey: KEY })
    assert.equal(saved.hasKey, true)
    assert.ok(!JSON.stringify(saved).includes(KEY), 'the window learns that a key exists, not what it is')
    assert.ok(!readFileSync(path.join(directory, 'assistant.json'), 'utf8').includes(KEY), 'not stored in the clear')
    assert.equal(settings.resolve().apiKey, KEY)
    settings.save({ provider: 'local', model: 'llama3.1', baseUrl: 'http://127.0.0.1:11434/v1' })
    assert.throws(() => settings.save({ apiKey: KEY }), /which provider/)
    assert.equal(settings.status().hasKey, false, 'each provider has its own key')
    assert.equal(settings.resolve().apiKey, undefined)
    settings.save({ provider: 'anthropic', clearKey: true })
    assert.equal(settings.status().hasKey, false)
    assert.throws(() => settings.save({ provider: 'local', baseUrl: 'ftp://x' }), /http/)
    assert.throws(() => settings.save({ provider: 'other' }), /Choose/)
    assert.throws(() => createAssistantSettings({ directory, safeStorage: { isEncryptionAvailable: () => false } }).save({ provider: 'anthropic', apiKey: KEY }), /Secure storage is not available/)
    assert.equal(createAssistantSettings({ directory, safeStorage }).status().canStoreKey, true)
    const plain = { ...safeStorage, getSelectedStorageBackend: () => 'basic_text' }
    const unsafe = createAssistantSettings({ directory, safeStorage: plain })
    assert.deepEqual([unsafe.status().canStoreKey, /no secret store/.test(unsafe.status().storeKeyReason)], [false, true])
    assert.throws(() => unsafe.save({ provider: 'anthropic', apiKey: KEY }), /no secret store/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

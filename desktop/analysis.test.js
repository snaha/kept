import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { FFMPEG_CONFIGURE, FFMPEG_SOURCE_SHA256, FFMPEG_SOURCE_URL, THIRD_PARTY_NOTICES } from '../shared/third-party.js'
import { createAnalyser, REFUSED_REASON, windowPlan } from './analysis/analyser.js'
import { createDecoder, excerptPlan } from './analysis/decode.js'
import { createDsp } from './analysis/dsp.js'
import { resolveFfmpeg, resolveModelDir } from './analysis/ffmpeg.js'
import { ANALYSIS_METHODS, DEFAULT_METHOD_ID, DSP_SIZE, EMBEDDING_SIZE, SAMPLE_RATE, currentMethod, decodeVector, dspFeatures, dspVector, encodeVector } from './analysis/methods.js'
import { loadOpenl3 } from './analysis/openl3.js'
import { ANALYSE_CLASS, ANALYSE_MODULE, analyseSubject, createAnalysis } from './analysis-jobs.js'
import { NAVIDROME_SOURCE, folderSource } from './catalog-ingest.js'
import { CatalogStore, STORE_METHODS } from './catalog-store.js'
import { FeatureDatabase } from './feature-database.js'
import { FEATURE_METHODS } from './feature-store.js'
import { nodeFork } from './library-process.js'
import { createLibraryService } from './library-service.js'
import { ResourcePolicy } from './resource-policy.js'

const T0 = 7000000
const METHOD = ANALYSIS_METHODS[DEFAULT_METHOD_ID]
const KEY = { method: METHOD.id, version: METHOD.version }
const FIXTURE = new URL('./tests/analyse-fixture.js', import.meta.url).href
const TOLERANCE = 1e-6
const LEVELS = [0.25, 0.5, 0.75]
const HASH_LENGTH = 64
const FIXTURE_ASSET_SIZE = 1000
const FIXTURE_DURATION = 200
const SINE_HZ = 1000
const SINE_SECONDS = 45
const PCM_BITS = 16
const PCM_PEAK = 12000
const WAV_HEADER_BYTES = 44
const RIFF_SIZE_OFFSET = 4
const RIFF_HEADER_BYTES = 8
const AU_HEADER_BYTES = 24
const AU_PCM16_BIG_ENDIAN = 3
const MEL_BASIS_BINS = 1025
const WINDOW_TEST_SECONDS = 3
const SYNTHETIC_PROBE_MEANS = { noise: -40.054656982421875, 'low-band': -62, 'time-step': -47.839195251464844 }
const WITHIN_PROBE_TOLERANCE = 1e-4
const PINNED_WEIGHTS = 'synthetic pinned weights'
// ONNX opset 17: ReduceMean(melspectrogram) expanded to [1, 512].
const MEAN_GRAPH = Buffer.from('CAg6xwEKMwoObWVsc3BlY3Ryb2dyYW0SBG1lYW4iClJlZHVjZU1lYW4qDwoIa2VlcGRpbXMYAKABAgogCgRtZWFuCgVzaGFwZRIJZW1iZWRkaW5nIgZFeHBhbmQSD3N5bnRoZXRpYy1wcm9iZSoQCAIQBzoDAYAEQgVzaGFwZVotCg5tZWxzcGVjdHJvZ3JhbRIbChkIARIVCgIIAQoCCAEKBhIEbWVscwoDCMcBYhwKCWVtYmVkZGluZxIPCg0IARIJCgIIAQoDCIAEQgQKABAR', 'base64')
// ModelProto producer_name adds metadata without changing inference.
const EQUIVALENT_GRAPH = Buffer.concat([Buffer.from('1211', 'hex'), Buffer.from('equivalent-export'), MEAN_GRAPH])
// ONNX opset 17: expand the noise probe's mean as a constant, ignoring the input.
const CONSTANT_GRAPH = Buffer.from('CAg6ogEKIAoEbWVhbgoFc2hhcGUSCWVtYmVkZGluZyIGRXhwYW5kEg9zeW50aGV0aWMtcHJvYmUqEAgCEAc6AwGABEIFc2hhcGVaLQoObWVsc3BlY3Ryb2dyYW0SGwoZCAESFQoCCAEKAggBCgYSBG1lbHMKAwjHAWIcCgllbWJlZGRpbmcSDwoNCAESCQoCCAEKAwiABCoOEAEiBPg3IMJCBG1lYW5CBAoAEBE=', 'base64')
const here = path.dirname(fileURLToPath(import.meta.url))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

const temporary = t => {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'kept-analysis-')))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}
const vector = (size, value) => new Float32Array(size).fill(value)
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < TOLERANCE, `${actual} is not ${expected}`)
const until = async (check, what, timeout = 10000) => {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${what}`)
    await sleep(10)
  }
}
const context = (payload, extra = {}) => ({ payload: { assetId: 'asset:a', file: '/music/level-0.5.wav', duration: 200, method: METHOD, ffmpeg: 'ffmpeg', modelDir: '/models', analysisAllowed: true, ...payload }, rest: async () => {}, signal: new AbortController().signal, save: () => {}, ...extra })

test('vectors survive the trip through a job result, and the stored DSP order is fixed', () => {
  const values = Float32Array.from({ length: EMBEDDING_SIZE }, (_, i) => Math.sin(i))
  assert.deepEqual(decodeVector(encodeVector(values)), values)
  const features = dspFeatures(dspVector({ ...dspFeatures(Float32Array.from({ length: DSP_SIZE }, (_, i) => i)), flatness: Number.NaN }))
  assert.deepEqual([features.loudnessDb, features.dynamicsDb, features.flatness, features.mfccMean[0], features.mfccStd.at(-1)], [0, 1, 0, 16, DSP_SIZE - 1])
  assert.equal(DSP_SIZE, 42)
})

test('the analysis method is a versioned configuration', () => {
  assert.equal(currentMethod({}).id, DEFAULT_METHOD_ID)
  assert.equal(currentMethod({ KEPT_ANALYSIS_METHOD: 'openl3-mel256-w15' }).mels, 256)
  assert.equal(currentMethod({ KEPT_ANALYSIS_METHOD: 'nonsense' }).id, DEFAULT_METHOD_ID)
  for (const [id, method] of Object.entries(ANALYSIS_METHODS)) {
    assert.deepEqual([method.id, method.licence, Number.isSafeInteger(method.version)], [id, 'CC-BY-4.0', true])
  }
})

function modelInstaller(t, { graph = MEAN_GRAPH } = {}) {
  const sandbox = temporary(t)
  for (const folder of ['scripts', 'analysis', 'supplied']) mkdirSync(path.join(sandbox, folder))
  for (const file of ['scripts/fetch-openl3.mjs', 'scripts/openl3-fingerprint.mjs', 'analysis/methods.js', 'analysis/openl3.js', 'analysis/fft.js']) {
    copyFileSync(path.join(here, file), path.join(sandbox, file))
  }
  symlinkSync(path.join(here, 'node_modules'), path.join(sandbox, 'node_modules'), 'junction')
  const supplied = path.join(sandbox, 'supplied')
  const models = path.join(sandbox, 'models')
  const onnx = `${METHOD.model}.onnx`
  const basis = `${METHOD.model.replace('-music-512', '')}-basis.f32`
  const basisBytes = Buffer.alloc(METHOD.mels * MEL_BASIS_BINS * Float32Array.BYTES_PER_ELEMENT)
  const weightFile = 'synthetic.pth.tar'
  const writeReference = (probeMeans = SYNTHETIC_PROBE_MEANS) => writeFileSync(path.join(sandbox, 'scripts/openl3-reference.json'), JSON.stringify({
    [METHOD.model]: {
      weights: { file: weightFile, sha256: digest(PINNED_WEIGHTS) },
      onnxSha256: digest(graph),
      basisSha256: digest(basisBytes),
      embeddings: Object.fromEntries(Object.entries(probeMeans).map(([name, mean]) => [name, Array(EMBEDDING_SIZE).fill(mean + WITHIN_PROBE_TOLERANCE)])),
    },
  }))
  writeReference()
  writeFileSync(path.join(supplied, onnx), graph)
  writeFileSync(path.join(supplied, basis), basisBytes)
  const run = (...args) => spawnSync(process.execPath, [path.join(sandbox, 'scripts/fetch-openl3.mjs'), ...args], {
    env: { ...process.env, KEPT_OPENL3_DIR: supplied },
    encoding: 'utf8',
  })
  return { sandbox, supplied, models, onnx, basis, basisBytes, weightFile, run, writeReference }
}

test('strict OpenL3 install validates supplied and cached graphs against every reference', t => {
  const { run, writeReference } = modelInstaller(t)
  const copied = run('--strict')
  assert.equal(copied.status, 0, copied.stderr)
  assert.match(copied.stdout, /copied from/)
  const cached = run('--strict')
  assert.equal(cached.status, 0, cached.stderr)
  assert.match(cached.stdout, /already present/)

  writeReference({ ...SYNTHETIC_PROBE_MEANS, 'time-step': SYNTHETIC_PROBE_MEANS['time-step'] + 1 })
  const strict = run('--strict')
  assert.equal(strict.status, 1)
  assert.match(strict.stderr, /fingerprint check: Embedding component \d+ for time-step/)
  const dev = run()
  assert.equal(dev.status, 0, dev.stderr)
  assert.match(dev.stderr, /warning: .* fingerprint check: Embedding component \d+ for time-step/)
})

test('strict OpenL3 install rejects a graph that always returns the first reference embedding', t => {
  const { models, onnx, run } = modelInstaller(t, { graph: CONSTANT_GRAPH })
  const strict = run('--strict')
  assert.equal(strict.status, 1)
  assert.match(strict.stderr, /Embeddings for noise and low-band are too similar/)
  assert.equal(existsSync(path.join(models, onnx)), false)
})

test('strict OpenL3 install replaces an unpinned cached graph with the supplied pinned pair', t => {
  const { sandbox, models, onnx, basis, basisBytes, weightFile, run } = modelInstaller(t)
  mkdirSync(models)
  writeFileSync(path.join(models, onnx), EQUIVALENT_GRAPH)
  writeFileSync(path.join(models, basis), basisBytes)
  // Make a mistaken export attempt fail locally before it can download anything.
  const work = path.join(sandbox, '.models-build')
  mkdirSync(work)
  writeFileSync(path.join(work, weightFile), 'corrupted weights')

  const result = run('--strict')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readFileSync(path.join(models, onnx)), MEAN_GRAPH)
  assert.deepEqual(readFileSync(path.join(models, basis)), basisBytes)
})

test('strict OpenL3 install replaces supplied and cached unpinned graphs even when their probes match', t => {
  const { sandbox, supplied, models, onnx, basis, weightFile, run } = modelInstaller(t)
  const work = path.join(sandbox, '.models-build')
  const bin = path.join(work, 'venv', 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(work, weightFile), PINNED_WEIGHTS)
  copyFileSync(path.join(supplied, onnx), path.join(work, onnx))
  copyFileSync(path.join(supplied, basis), path.join(work, basis))
  // Stand in for PyTorch while keeping the installer, weight check and WASM real.
  writeFileSync(path.join(bin, 'python'), `#!/bin/sh\nset -eu\ncp "${work}/${onnx}" "${work}/${basis}" "$3"\n`, { mode: 0o755 })
  for (const source of [supplied, models]) {
    writeFileSync(path.join(source, onnx), EQUIVALENT_GRAPH)
    const strict = run('--strict')
    assert.equal(strict.status, 0, strict.stderr)
    assert.deepEqual(readFileSync(path.join(models, onnx)), MEAN_GRAPH)
  }
})

test('OpenL3 installation rejects a same-size mel basis change in both modes', t => {
  const { supplied, models, onnx, basis, basisBytes, run } = modelInstaller(t)
  basisBytes[0] = 1
  writeFileSync(path.join(supplied, basis), basisBytes)
  for (const source of [supplied, models]) {
    if (source === models) {
      copyFileSync(path.join(supplied, onnx), path.join(models, onnx))
      copyFileSync(path.join(supplied, basis), path.join(models, basis))
    }
    for (const args of [[], ['--strict']]) {
      const result = run(...args)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /basis\.f32 does not match its checksum/)
      assert.equal(existsSync(path.join(models, onnx)), source === models)
    }
  }
})

test('the OpenL3 weights checksum is fatal even in development', t => {
  const { sandbox, supplied, weightFile, run } = modelInstaller(t)
  rmSync(supplied, { recursive: true })
  const cache = path.join(sandbox, '.models-build')
  mkdirSync(cache)
  writeFileSync(path.join(cache, weightFile), 'corrupted weights')
  const result = run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /weights .* do not match their checksum/)
})

test('excerpts are spread over a track and windows over the excerpts', () => {
  assert.deepEqual(excerptPlan(200, METHOD), [{ start: 35, seconds: 10 }, { start: 95, seconds: 10 }, { start: 155, seconds: 10 }])
  // A short track, or one of unknown length, is read once from the start.
  assert.deepEqual(excerptPlan(25, METHOD), [{ start: 0, seconds: 30 }])
  assert.deepEqual(excerptPlan(0, METHOD), [{ start: 0, seconds: 30 }])
  const excerpts = [0, 1, 2].map(() => new Float32Array(SAMPLE_RATE * METHOD.excerptSeconds))
  const offsets = windowPlan(excerpts, 15)
  assert.deepEqual(offsets.map(list => list.length), [5, 5, 5])
  assert.deepEqual(offsets[0], [0, 2, 4, 6, 8].map(second => second * SAMPLE_RATE))
  assert.deepEqual(windowPlan(excerpts, METHOD.windows).map(list => list.length), [2, 2, 2])
  assert.deepEqual(windowPlan([new Float32Array(SAMPLE_RATE * 3)], METHOD.windows), [[0, 2 * SAMPLE_RATE]])
})

test('the analyser averages the window embeddings, loads the model once and rests between windows', async () => {
  const calls = { decode: 0, load: 0, embed: 0, rest: 0 }
  const analyse = createAnalyser({
    decode: async request => { calls.decode++; return METHOD.excerptPositions.map((_, index) => vector(request.sampleRate * METHOD.excerptSeconds, index + 1)) },
    loadModel: async (modelDir, method) => { calls.load++; assert.deepEqual([modelDir, method.model], ['/models', METHOD.model]); return { embed: async (audio, offset) => { calls.embed++; return vector(EMBEDDING_SIZE, audio[offset]) } } },
    createDsp: () => ({ analyse: excerpts => dspFeatures(vector(DSP_SIZE, excerpts.length)) }),
  })
  const result = await analyse(context({}, { rest: async () => { calls.rest++ } }))
  assert.deepEqual([result.outcome, result.assetId, result.method, result.version, result.windows], ['done', 'asset:a', METHOD.id, METHOD.version, METHOD.windows])
  // Excerpts hold 1, 2 and 3: the mean over five windows of each is 2.
  const embedding = decodeVector(result.embedding)
  close(embedding[0], 2)
  close(embedding[EMBEDDING_SIZE - 1], 2)
  assert.deepEqual(decodeVector(result.dsp), vector(DSP_SIZE, METHOD.excerptPositions.length))
  assert.ok(calls.rest >= METHOD.windows, `rested ${calls.rest} times`)
  await analyse(context({ assetId: 'asset:b' }))
  assert.deepEqual([calls.decode, calls.load, calls.embed], [2, 1, 2 * METHOD.windows])
})

test('a cold WASM analyser started while idle keeps one thread when playback begins mid-track', async t => {
  const modelDir = temporary(t)
  writeFileSync(path.join(modelDir, `${METHOD.model}.onnx`), MEAN_GRAPH)
  writeFileSync(path.join(modelDir, `${METHOD.model.replace('-music-512', '')}-basis.f32`),
    Buffer.alloc(METHOD.mels * MEL_BASIS_BINS * Float32Array.BYTES_PER_ELEMENT))
  const workerCount = () => process.report.getReport().workers.length
  const before = workerCount()
  let idle = true
  let releaseModel
  t.after(() => releaseModel?.())
  const threadCounts = []
  const analyse = createAnalyser({
    decode: async request => [vector(request.sampleRate * WINDOW_TEST_SECONDS, 1)],
    loadModel: async (directory, method) => {
      const model = await loadOpenl3(directory, method)
      releaseModel = model.release
      return { ...model, embed: async (audio, offset) => {
        const embedding = await model.embed(audio, offset)
        threadCounts.push(workerCount())
        idle = false
        return embedding
      } }
    },
    createDsp: () => ({ analyse: () => dspFeatures(vector(DSP_SIZE, 0)) }),
  })
  const result = await analyse(context({ modelDir }, { idle: () => idle }))
  assert.equal(result.outcome, 'done')
  assert.deepEqual(threadCounts, [before, before])
})

test('the model counts as missing when its mel basis is not installed, and the sweep queues nothing', async t => {
  const h = library(t, { basis: false })
  await h.service.start()
  const stats = await h.service.analyse()
  assert.deepEqual([stats.ready, stats.missing, stats.queued], [false, 'no sound model', 0])
})

test('prepare reads the policy as it is when the job runs and the analyser refuses a forbidden source', async t => {
  const h = library(t)
  const job = { payload: { assetId: h.assetIds[0], sourceId: h.source.id, ...KEY } }
  assert.equal((await h.analysis.jobClass.prepare(job)).analysisAllowed, true)
  h.raw.registerSource({ ...h.source, policy: { ...h.source.policy, analysisAllowed: false } })
  assert.equal((await h.analysis.jobClass.prepare(job)).analysisAllowed, false)
})

test('the analyser refuses a job that does not say analysis is allowed, before anything is read', async () => {
  const touched = []
  const analyse = createAnalyser({
    decode: async () => { touched.push('decode'); return [] },
    loadModel: async () => { touched.push('model'); return { embed: async () => vector(EMBEDDING_SIZE, 0) } },
    createDsp: () => { touched.push('dsp'); return { analyse: () => ({}) } },
  })
  for (const analysisAllowed of [false, undefined, 'true', 1]) {
    assert.deepEqual(await analyse(context({ analysisAllowed })), { assetId: 'asset:a', method: METHOD.id, version: METHOD.version, outcome: 'refused', reason: REFUSED_REASON })
  }
  assert.deepEqual(touched, [])
})

test('a file that cannot be decoded is an outcome, a decoder that cannot run is a failure', async () => {
  const failing = error => createAnalyser({ decode: async () => { throw error }, loadModel: async () => ({}), createDsp: () => ({}) })
  const unreadable = await failing(Object.assign(new Error('ffmpeg exited 1: invalid data'), { undecodable: true }))(context({}))
  assert.deepEqual([unreadable.outcome, unreadable.reason], ['unreadable', 'ffmpeg exited 1: invalid data'])
  await assert.rejects(failing(new Error('spawn ffmpeg ENOENT'))(context({})), /ENOENT/)
  const silent = await createAnalyser({ decode: async () => [], loadModel: async () => ({}), createDsp: () => ({}) })(context({}))
  assert.deepEqual([silent.outcome, silent.reason], ['unreadable', 'no audio decoded'])
  // A cancelled job stops between windows.
  const controller = new AbortController()
  const cancelled = createAnalyser({
    decode: async () => [vector(SAMPLE_RATE * METHOD.excerptSeconds, 0)],
    loadModel: async () => ({ embed: async () => { controller.abort(); return vector(EMBEDDING_SIZE, 0) } }),
    createDsp: () => ({ analyse: () => dspFeatures(vector(DSP_SIZE, 0)) }),
  })
  await assert.rejects(cancelled(context({}, { signal: controller.signal })), /Aborted/)
})

test('the bundled ffmpeg comes first, the system one only in development', () => {
  const desktop = '/kept/desktop', resources = '/Kept.app/Contents/Resources'
  const having = files => file => files.includes(file)
  const env = { PATH: '/somewhere/bin:/usr/bin' }
  assert.deepEqual(resolveFfmpeg({ packaged: false, resources, desktop, env, exists: having(['/kept/desktop/bin/ffmpeg', '/usr/bin/ffmpeg']) }), { file: '/kept/desktop/bin/ffmpeg', bundled: true })
  assert.deepEqual(resolveFfmpeg({ packaged: false, resources, desktop, env, exists: having(['/usr/bin/ffmpeg']) }), { file: '/usr/bin/ffmpeg', bundled: false })
  assert.deepEqual(resolveFfmpeg({ packaged: false, resources, desktop, env: { ...env, KEPT_FFMPEG: '/custom/ffmpeg' }, exists: having(['/custom/ffmpeg', '/usr/bin/ffmpeg']) }), { file: '/custom/ffmpeg', bundled: false })
  assert.deepEqual(resolveFfmpeg({ packaged: true, resources, desktop, env, exists: having([`${resources}/ffmpeg`, '/usr/bin/ffmpeg']) }), { file: `${resources}/ffmpeg`, bundled: true })
  // A packaged app never falls back: what it runs is what its notices declare.
  assert.equal(resolveFfmpeg({ packaged: true, resources, desktop, env: { ...env, KEPT_FFMPEG: '/custom/ffmpeg' }, exists: having(['/custom/ffmpeg', '/usr/bin/ffmpeg', '/kept/desktop/bin/ffmpeg']) }), undefined)
  assert.equal(resolveFfmpeg({ packaged: false, resources, desktop, env, exists: () => false }), undefined)
  assert.equal(resolveModelDir({ packaged: true, resources, desktop }), `${resources}/models`)
  assert.equal(resolveModelDir({ packaged: false, resources, desktop }), '/kept/desktop/models')
})

test('the declared ffmpeg build is LGPL, audio only and pinned', () => {
  for (const flag of ['--disable-gpl', '--disable-nonfree', '--disable-everything', '--disable-autodetect', '--disable-network']) assert.ok(FFMPEG_CONFIGURE.includes(flag), flag)
  assert.ok(!FFMPEG_CONFIGURE.some(flag => /^--enable-(gpl|nonfree|version3|lib)/.test(flag)))
  const enabled = name => FFMPEG_CONFIGURE.find(flag => flag.startsWith(`--enable-${name}=`)).split('=')[1].split(',')
  for (const decoder of ['mp3', 'flac', 'aac', 'alac', 'vorbis', 'opus', 'pcm_s16le', 'pcm_s16be']) assert.ok(enabled('decoder').includes(decoder), decoder)
  assert.deepEqual(enabled('demuxer'), ['mp3', 'flac', 'mov', 'ogg', 'wav', 'aiff'])
  assert.deepEqual([enabled('encoder'), enabled('muxer')], [['pcm_f32le'], ['pcm_f32le']])
  assert.match(FFMPEG_SOURCE_SHA256, /^[0-9a-f]{64}$/)
  const notice = id => THIRD_PARTY_NOTICES.find(entry => entry.id === id)
  assert.equal(notice('ffmpeg').configure, `./configure ${FFMPEG_CONFIGURE.join(' ')}`)
  assert.equal(notice('ffmpeg').source, FFMPEG_SOURCE_URL)
  assert.match(notice('ffmpeg').licence, /^LGPL/)
  assert.match(notice('ffmpeg').terms.join(' '), /Source offer/)
  assert.match(notice('openl3').licence, /CC BY 4\.0/)
  assert.match(notice('openl3').attribution, /Cramer.*Salamon.*Bello/)
  for (const id of ['navidrome', 'ffmpeg', 'onnxruntime-web', 'openl3', 'electron']) assert.ok(notice(id).source.startsWith('https://'), id)
})

// A catalog with one music folder (three tracks of one album, one loose track) and one provider that forbids analysis.
const SPOTIFY = { id: 'spotify', kind: 'spotify', label: 'Spotify', evidenceClass: 'deterministic', licence: 'proprietary', policy: { analysisAllowed: false, network: 'internet', consent: 'online-lookups' } }
const hashOf = index => String(index + 1).repeat(HASH_LENGTH)
const library = (t, { module = FIXTURE, ffmpeg = 'ffmpeg', files = LEVELS.map(level => `album/level-${level}.wav`), basis = true, duration = FIXTURE_DURATION } = {}) => {
  const directory = temporary(t)
  const folder = path.join(directory, 'music'), modelDir = path.join(directory, 'models')
  mkdirSync(folder)
  mkdirSync(modelDir)
  writeFileSync(path.join(modelDir, `${METHOD.model}.onnx`), '')
  if (basis) writeFileSync(path.join(modelDir, `${METHOD.model.replace('-music-512', '')}-basis.f32`), '')
  const raw = new CatalogStore(path.join(directory, 'library.sqlite'))
  const catalog = Object.fromEntries(STORE_METHODS.map(method => [method, async request => raw.call(method, request)]))
  const source = folderSource(folder)
  raw.registerSource(NAVIDROME_SOURCE)
  raw.registerSource(source)
  raw.registerSource(SPOTIFY)
  const scan = { observedAt: T0, rootAvailable: true, complete: true }
  const local = raw.ingestScan({ ...scan, sourceId: source.id, providerSourceId: NAVIDROME_SOURCE.id, files: files.map((file, index) => ({ path: file, contentHash: hashOf(index), size: FIXTURE_ASSET_SIZE + index, duration, providerTrackId: `song-${index}`, providerAlbumId: 'nd-album' })) })
  const provider = raw.ingestScan({ ...scan, sourceId: SPOTIFY.id, files: [{ path: 'spotify-track-1', contentHash: 'f'.repeat(HASH_LENGTH), size: 5000, duration: 180 }] })
  const featureFile = path.join(directory, 'features.sqlite')
  const state = { database: new FeatureDatabase(featureFile), errors: [], enabled: true }
  const features = Object.fromEntries(FEATURE_METHODS.map(method => [method, request => state.database.store[method](request)]))
  for (const file of files) { mkdirSync(path.dirname(path.join(folder, file)), { recursive: true }); writeFileSync(path.join(folder, file), '') }
  const analysis = createAnalysis({ catalog, features, folders: () => [folder], ffmpeg, modelDir, method: METHOD, module, onError: error => state.errors.push(error.message) })
  const policy = new ResourcePolicy()
  const service = createLibraryService({ store: catalog, fork: nodeFork, classes: [], policy, analysis, onError: error => state.errors.push(error.message) })
  t.after(async () => { await service.stop(); await state.database.close(); raw.close() })
  const jobOf = async assetId => raw.get('SELECT * FROM jobs WHERE class=? AND subject=?', ANALYSE_CLASS, analyseSubject(METHOD, assetId))
  const settled = () => until(async () => (await service.status()).classes[ANALYSE_CLASS]?.queued + (await service.status()).classes[ANALYSE_CLASS]?.running === 0 || !(await service.status()).classes[ANALYSE_CLASS], 'the analysis queue empties')
  return { raw, catalog, features, state, analysis, service, policy, folder, modelDir, source, featureFile, assetIds: local.assetIds, albumId: local.albumIds[0], providerAssetId: provider.assetIds[0], jobOf, settled }
}

test('analysis pages read locations in one query and a refused copy blocks its whole asset', async t => {
  const h = library(t)
  const [first, second] = h.assetIds
  const copy = 'synthetic-copy.wav'
  h.raw.ingestScan({
    sourceId: SPOTIFY.id, observedAt: T0, rootAvailable: true, complete: false,
    files: [{ path: copy, contentHash: hashOf(0), size: FIXTURE_ASSET_SIZE }],
  })
  const statement = t.mock.method(h.raw, 'statement')
  const { assets, next } = await h.catalog.analysisCandidates({ limit: 1 })
  assert.equal(next, first)
  assert.deepEqual(assets.map(({ assetId, analysisAllowed, availability, locations }) => ({
    assetId, analysisAllowed, availability, sources: locations.map(({ sourceId }) => sourceId),
  })), [{ assetId: first, analysisAllowed: false, availability: 'available', sources: [h.source.id, SPOTIFY.id] }])
  assert.equal(statement.mock.callCount(), 1, 'fetch policy and locations with the page')
  const following = await h.catalog.analysisCandidates({ after: next, limit: 1 })
  assert.equal(following.assets[0].assetId, second)
  assert.equal(following.assets[0].analysisAllowed, true)
})

test('a library is analysed in the analyser process, and its features and album aggregate are stored', async t => {
  const h = library(t)
  await h.service.start()
  const stats = await h.service.analyse()
  assert.deepEqual([stats.assets, stats.queued, stats.refused, stats.ready], [LEVELS.length + 1, LEVELS.length, 1, true])
  await until(async () => (await h.features.featureCounts(KEY)).tracks === LEVELS.length, 'every track is analysed')
  for (const [index, assetId] of h.assetIds.entries()) {
    const { features } = await h.features.getTrackFeatures({ ...KEY, assetId })
    close(features.embedding[0], LEVELS[index])
    assert.deepEqual([features.embedding.length, features.dsp.length, features.windows], [EMBEDDING_SIZE, DSP_SIZE, METHOD.windows])
  }
  await until(async () => (await h.features.getAlbumFeatures({ ...KEY, albumId: h.albumId })).features?.tracks === LEVELS.length, 'the album aggregate covers every track')
  close((await h.features.getAlbumFeatures({ ...KEY, albumId: h.albumId })).features.embedding[0], 0.5)
  // The queue keeps a receipt, not the vectors.
  await h.settled()
  const job = await h.jobOf(h.assetIds[0])
  assert.deepEqual([job.state, Object.keys(JSON.parse(job.result)).sort()], ['done', ['assetId', 'outcome', 'timing', 'windows']])
  assert.deepEqual(JSON.parse(job.payload), { assetId: h.assetIds[0], sourceId: h.source.id, ...KEY })
  // A second sweep finds nothing to do.
  const again = await h.service.analyse()
  assert.deepEqual([again.queued, again.settled, again.refused], [0, LEVELS.length, 1])
  assert.deepEqual(h.state.errors, [])
})

test('an asset whose source forbids analysis is refused when it would be enqueued', async t => {
  const h = library(t)
  await h.service.start()
  await h.service.analyse()
  assert.equal(await h.jobOf(h.providerAssetId), undefined, 'no job exists for the provider asset')
  assert.deepEqual((await h.features.listOutcomes({ ...KEY, outcome: 'refused' })).outcomes.map(({ assetId, reason }) => [assetId, reason]), [[h.providerAssetId, REFUSED_REASON]])
  await h.settled()
  assert.equal((await h.features.getTrackFeatures({ ...KEY, assetId: h.providerAssetId })).features, undefined)
  // A job that names the provider source is refused by the queue itself.
  await assert.rejects(h.service.worker.enqueue([{ class: ANALYSE_CLASS, subject: 'forced-source', payload: { assetId: h.providerAssetId, sourceId: SPOTIFY.id, ...KEY } }]), /refused/)
  // One that names an allowed source for the provider's asset is refused when it is claimed: the handler never sees it.
  const [id] = await h.service.worker.enqueue([{ class: ANALYSE_CLASS, subject: 'forced', payload: { assetId: h.providerAssetId, sourceId: h.source.id, ...KEY } }])
  assert.deepEqual(await h.service.worker.waitFor(id), { assetId: h.providerAssetId, outcome: 'refused', reason: REFUSED_REASON })
  assert.equal((await h.features.featureCounts(KEY)).tracks, LEVELS.length)
})

test('a policy that changes after the job was queued is honoured when the job runs', async t => {
  const h = library(t)
  // Nothing runs yet: the audio is waiting.
  h.service.reportPlayback({ kind: 'state', playing: true, waiting: true })
  await h.service.start()
  assert.equal((await h.service.analyse()).queued, LEVELS.length)
  assert.equal((await h.jobOf(h.assetIds[0])).state, 'queued')
  // The folder's owner forbids analysis before any job starts.
  h.raw.registerSource({ ...h.source, policy: { ...h.source.policy, analysisAllowed: false } })
  h.service.reportPlayback({ kind: 'state', playing: false, waiting: false })
  await until(async () => (await h.features.featureCounts(KEY)).outcomes.refused === LEVELS.length + 1, 'every job is refused')
  assert.equal((await h.features.featureCounts(KEY)).tracks, 0)
  await h.settled()
  assert.deepEqual(JSON.parse((await h.jobOf(h.assetIds[0])).result), { assetId: h.assetIds[0], outcome: 'refused', reason: REFUSED_REASON })
  // Allowed again: the refusal is not final, the next sweep analyses them.
  h.raw.registerSource(h.source)
  assert.equal((await h.service.analyse()).queued, LEVELS.length)
  await until(async () => (await h.features.featureCounts(KEY)).tracks === LEVELS.length, 'the tracks are analysed once allowed')
  // Forbidden after the analysis: the sweep removes what was computed.
  h.raw.registerSource({ ...h.source, policy: { ...h.source.policy, analysisAllowed: false } })
  const stats = await h.service.analyse()
  assert.deepEqual([stats.refused, stats.queued], [LEVELS.length + 1, 0])
  assert.deepEqual([(await h.features.featureCounts(KEY)).tracks, (await h.features.featureCounts(KEY)).albums], [0, 0])
})

test('deleting features.sqlite queues the whole library again', async t => {
  const h = library(t)
  await h.service.start()
  await h.service.analyse()
  await until(async () => (await h.features.featureCounts(KEY)).tracks === LEVELS.length, 'every track is analysed')
  await h.settled()
  assert.equal((await h.service.analyse()).queued, 0)
  await h.state.database.close()
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${h.featureFile}${suffix}`, { force: true })
  h.state.database = new FeatureDatabase(h.featureFile)
  assert.equal((await h.features.featureCounts(KEY)).tracks, 0)
  const stats = await h.service.analyse()
  assert.deepEqual([stats.queued, stats.refused], [LEVELS.length, 1])
  await until(async () => (await h.features.featureCounts(KEY)).tracks === LEVELS.length, 'every track is analysed again')
  await until(async () => (await h.features.getAlbumFeatures({ ...KEY, albumId: h.albumId })).features?.tracks === LEVELS.length, 'the album aggregate is back')
})

test('unreadable files are recorded once, unavailable ones wait, and a missing decoder queues nothing', async t => {
  const h = library(t, { files: ['album/level-0.5.wav', 'album/silent.wav', 'album/broken.wav'] })
  await h.service.start()
  await h.service.analyse()
  await until(async () => (await h.features.featureCounts(KEY)).outcomes.unreadable === 2, 'both unreadable files are recorded')
  await h.settled()
  assert.deepEqual((await h.features.listOutcomes({ ...KEY, outcome: 'unreadable' })).outcomes.map(entry => entry.reason).sort(), ['ffmpeg exited 1: invalid data', 'no audio decoded'])
  const again = await h.service.analyse()
  assert.deepEqual([again.queued, again.settled], [0, 3])
  // A file that vanished after the scan is not called unreadable: its job ends without a verdict and the next sweep asks again.
  await h.features.pruneMethods({ keep: [] })
  rmSync(path.join(h.folder, 'album/level-0.5.wav'))
  assert.equal((await h.service.analyse()).queued, 3)
  await until(async () => (await h.features.featureCounts(KEY)).outcomes.unreadable === 2, 'the other two are recorded again')
  await h.settled()
  assert.deepEqual([(await h.features.featureCounts(KEY)).tracks, JSON.parse((await h.jobOf(h.assetIds[0])).result).outcome], [0, 'unavailable'])
  assert.equal((await h.service.analyse()).queued, 1)
  await h.settled()
  // The drive is unplugged: its assets are kept and nothing is queued for them.
  await h.features.pruneMethods({ keep: [] })
  h.raw.ingestScan({ sourceId: h.source.id, observedAt: T0 + 1, rootAvailable: false, complete: false, files: [] })
  const offline = await h.service.analyse()
  assert.deepEqual([offline.queued, offline.unavailable], [0, 3])
  // No decoder or no model: refusals are still recorded, nothing is queued.
  const bare = library(t, { ffmpeg: '' })
  await bare.service.start()
  const stats = await bare.service.analyse()
  assert.deepEqual([stats.ready, stats.missing, stats.queued, stats.refused], [false, 'no audio decoder', 0, 1])
  assert.equal(bare.analysis.ready, false)
})

test('one analysis runs at a time, whatever the policy allows', async t => {
  const h = library(t)
  h.service.reportPlayback({ kind: 'state', playing: true, waiting: true })
  await h.service.start()
  await h.service.analyse()
  const seen = []
  const claim = h.catalog.claimJobs
  h.service.worker.store = { ...h.catalog, claimJobs: async request => { const answer = await claim(request); if (answer.jobs.length) seen.push(h.service.worker.running.size + answer.jobs.length); return answer } }
  h.service.reportPlayback({ kind: 'state', playing: false, waiting: false })
  await until(async () => (await h.features.featureCounts(KEY)).tracks === LEVELS.length, 'every track is analysed')
  assert.ok(seen.length >= LEVELS.length && seen.every(count => count === 1), `claimed ${seen}`)
})

// The real decoder and the real model, when this checkout has them (scripts/build-ffmpeg.mjs, scripts/fetch-openl3.mjs).
const sineWav = (file, seconds = SINE_SECONDS) => {
  const samples = SAMPLE_RATE * seconds, bytes = samples * (PCM_BITS / 8)
  const buffer = Buffer.alloc(WAV_HEADER_BYTES + bytes)
  buffer.write('RIFF', 0, 'latin1'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8, 'latin1'); buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(SAMPLE_RATE, 24); buffer.writeUInt32LE(SAMPLE_RATE * (PCM_BITS / 8), 28)
  buffer.writeUInt16LE(PCM_BITS / 8, 32); buffer.writeUInt16LE(PCM_BITS, 34); buffer.write('data', 36, 'latin1'); buffer.writeUInt32LE(bytes, 40)
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(PCM_PEAK * Math.sin((2 * Math.PI * SINE_HZ * i) / SAMPLE_RATE)), WAV_HEADER_BYTES + i * (PCM_BITS / 8))
  writeFileSync(file, buffer)
  return file
}
const decoder = resolveFfmpeg({ packaged: false, resources: '', desktop: here })
const modelDir = resolveModelDir({ packaged: false, resources: '', desktop: here })
const hasModel = existsSync(path.join(modelDir, `${METHOD.model}.onnx`))

test('a file that disappears after preparation is analysed on the next sweep after it returns', { skip: decoder ? false : 'no ffmpeg in this checkout' }, async t => {
  const relativePath = 'synthetic-retry.wav'
  const h = library(t, { files: [relativePath], ffmpeg: decoder.file, duration: 0 })
  const file = sineWav(path.join(h.folder, relativePath), 2)
  const [assetId] = h.assetIds
  const prepare = h.analysis.jobClass.prepare
  const prepared = t.mock.method(h.analysis.jobClass, 'prepare', async job => {
    const payload = await prepare(job)
    assert.equal(payload.file, file)
    rmSync(file)
    return payload
  })

  await h.service.start()
  assert.equal((await h.service.analyse()).queued, 1)
  await h.settled()
  assert.equal(prepared.mock.callCount(), 1, 'the file survived the queue preflight')
  assert.equal(JSON.parse((await h.jobOf(assetId)).result).outcome, 'unavailable')
  assert.deepEqual((await h.features.pendingAssets({ ...KEY, assetIds: [assetId] })).assetIds, [assetId])

  prepared.mock.restore()
  sineWav(file, 2)
  assert.equal((await h.service.analyse()).queued, 1)
  await h.settled()
  assert.equal(JSON.parse((await h.jobOf(assetId)).result).outcome, 'done')
  assert.equal((await h.features.getTrackFeatures({ ...KEY, assetId })).features.assetId, assetId)
})

test('a track with an unknown duration and an error-like title saves features through the queue', { skip: decoder ? false : 'no ffmpeg in this checkout' }, async t => {
  const relativePath = 'synthetic-title.wav'
  const h = library(t, { files: [relativePath], ffmpeg: decoder.file, duration: 0, module: ANALYSE_MODULE })
  writeFileSync(path.join(h.modelDir, `${METHOD.model}.onnx`), MEAN_GRAPH)
  writeFileSync(path.join(h.modelDir, `${METHOD.model.replace('-music-512', '')}-basis.f32`),
    Buffer.alloc(METHOD.mels * MEL_BASIS_BINS * Float32Array.BYTES_PER_ELEMENT))
  const file = sineWav(path.join(h.folder, relativePath), 2)
  // RIFF LIST/INFO/INAM metadata, matching a real FFmpeg diagnostic in its title.
  const title = Buffer.from('LIST\x1e\x00\x00\x00INFOINAM\x12\x00\x00\x00Permission denied\x00', 'latin1')
  const wav = Buffer.concat([readFileSync(file), title])
  wav.writeUInt32LE(wav.length - RIFF_HEADER_BYTES, RIFF_SIZE_OFFSET)
  writeFileSync(file, wav)

  const [assetId] = h.assetIds
  await h.service.start()
  assert.equal((await h.service.analyse()).queued, 1)
  await h.settled()
  assert.equal(JSON.parse((await h.jobOf(assetId)).result).outcome, 'done')
  assert.equal((await h.features.getTrackFeatures({ ...KEY, assetId })).features?.assetId, assetId)
  assert.equal((await h.service.analyse()).queued, 0)
})

test('ffmpeg decodes bounded excerpts and the signal-processing features describe them', { skip: decoder ? false : 'no ffmpeg in this checkout' }, async t => {
  const file = sineWav(path.join(temporary(t), 'sine.wav'))
  const decode = createDecoder(decoder.file)
  // The duration is read from the file when the catalog does not know it.
  const excerpts = await decode({ file, duration: 0, method: METHOD, sampleRate: SAMPLE_RATE })
  assert.deepEqual(excerpts.map(excerpt => excerpt.length), METHOD.excerptPositions.map(() => SAMPLE_RATE * METHOD.excerptSeconds))
  const features = createDsp(SAMPLE_RATE).analyse(excerpts)
  assert.ok(Math.abs(features.centroidHz - SINE_HZ) < 50, `centroid ${features.centroidHz}`)
  assert.equal(dspVector(features).length, DSP_SIZE)
  writeFileSync(path.join(path.dirname(file), 'noise.mp3'), 'not audio at all')
  await assert.rejects(decode({ file: path.join(path.dirname(file), 'noise.mp3'), duration: 100, method: METHOD, sampleRate: SAMPLE_RATE }), error => error.undecodable === true)
})

test('bundled ffmpeg reports a valid but unsupported Sun AU file as unreadable', { skip: decoder?.bundled ? false : 'no bundled ffmpeg in this checkout' }, async t => {
  const payloadBytes = SAMPLE_RATE * Int16Array.BYTES_PER_ELEMENT
  const audio = Buffer.alloc(AU_HEADER_BYTES + payloadBytes)
  audio.write('.snd')
  const header = [AU_HEADER_BYTES, payloadBytes, AU_PCM16_BIG_ENDIAN, SAMPLE_RATE, 1]
  header.forEach((value, i) => audio.writeUInt32BE(value, (i + 1) * Uint32Array.BYTES_PER_ELEMENT))
  const file = path.join(temporary(t), 'synthetic.au')
  writeFileSync(file, audio)
  const analyse = createAnalyser({
    decode: createDecoder(decoder.file),
    loadModel: () => assert.fail('an unsupported container should never reach the model'),
    createDsp,
  })
  const result = await analyse(context({ file, duration: 1, ffmpeg: decoder.file }))
  assert.equal(result.outcome, 'unreadable')
  assert.match(result.reason, /^ffmpeg exited /)
})

test('the real analyser embeds a file with OpenL3 on one WASM thread', { skip: decoder && hasModel ? false : 'no ffmpeg or no model in this checkout' }, async t => {
  const file = sineWav(path.join(temporary(t), 'sine.wav'))
  const analyse = createAnalyser({ decode: request => createDecoder(request.ffmpeg)(request), loadModel: loadOpenl3, createDsp })
  const method = METHOD
  const result = await analyse(context({ file, duration: SINE_SECONDS, method, ffmpeg: decoder.file, modelDir }))
  assert.deepEqual([result.outcome, result.windows], ['done', method.windows])
  const embedding = decodeVector(result.embedding)
  assert.equal(embedding.length, EMBEDDING_SIZE)
  assert.ok(embedding.every(Number.isFinite) && embedding.some(value => value !== 0))
  // The same audio gives the same embedding.
  const again = decodeVector((await analyse(context({ file, duration: SINE_SECONDS, method, ffmpeg: decoder.file, modelDir }))).embedding)
  assert.deepEqual(again, embedding)
})

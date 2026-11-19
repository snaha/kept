// Walks a collection (read-only), and writes one JSON line per track with tags, DSP features,
// the mean OpenL3 embedding and the time spent in each stage.
// Usage: node src/analyse.js --root <dir> [--shard i/n] [--limit n] [--name tracks] [--skip-openl3]
//        [--mels 128|256] [--windows n] [--threads n] [--keep-windows] [--skip-dsp]
// --windows is the OpenL3 window count per track (15 = every other second of each excerpt).
// --keep-windows stores every window embedding, so smaller window counts can be scored without a re-run.
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { decodeExcerpts, probe } from './decode.js'
import { createDsp } from './dsp.js'
import { EMBEDDING_SIZE, loadOpenl3, SAMPLE_RATE, thin } from './openl3.js'

const OUT_DIR = new URL('../out', import.meta.url).pathname
const AUDIO_EXTENSIONS = /\.(mp3|flac|m4a|wav|ogg|opus|aiff?)$/i
const EMBEDDING_STRIDE_SECONDS = 2
const FULL_WINDOWS = 15
const BYTES_PER_MB = 2 ** 20
const KB_PER_MB = 1024

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? fallback : process.argv[index + 1]
}
const root = argument('root')
if (!root) throw new Error('--root is required')
const [shard, shards] = argument('shard', '0/1').split('/').map(Number)
const limit = Number(argument('limit', Infinity))
const name = argument('name', 'tracks')
const withOpenl3 = !process.argv.includes('--skip-openl3')
const withDsp = !process.argv.includes('--skip-dsp')
const keepWindows = process.argv.includes('--keep-windows')
const mels = Number(argument('mels', 256))
const windows = Number(argument('windows', FULL_WINDOWS))
const threads = Number(argument('threads', 1))

async function listAudio(dir) {
  const files = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await listAudio(path)))
    else if (AUDIO_EXTENSIONS.test(entry.name) && !entry.name.startsWith('._')) files.push(path)
  }
  return files
}

function meanEmbedding(embeddings) {
  const result = new Float32Array(EMBEDDING_SIZE)
  for (const embedding of embeddings) for (let i = 0; i < EMBEDDING_SIZE; i++) result[i] += embedding[i] / embeddings.length
  return result
}

await mkdir(OUT_DIR, { recursive: true })
const outFile = join(OUT_DIR, `${name}-${shard}.jsonl`)
const done = new Set((await readFile(outFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line).path))
const files = (await listAudio(root)).sort().filter((_, index) => index % shards === shard).slice(0, limit)
const dsp = createDsp(SAMPLE_RATE)
const openl3 = withOpenl3 ? await loadOpenl3(join(OUT_DIR, 'model'), { mels, threads }) : undefined
const started = performance.now()
let analysed = 0

for (const file of files) {
  const path = relative(root, file)
  if (done.has(path)) continue
  try {
    const t0 = performance.now()
    const tags = await probe(file)
    const t1 = performance.now()
    const excerpts = await decodeExcerpts(file, tags.duration, SAMPLE_RATE)
    const t2 = performance.now()
    if (!excerpts.length) throw new Error('no audio decoded')
    const features = withDsp ? dsp.analyse(excerpts) : undefined
    const t3 = performance.now()
    const timing = { probeMs: t1 - t0, decodeMs: t2 - t1, dspMs: t3 - t2, melMs: 0, inferMs: 0, windows: 0 }
    let embedding
    let windowEmbeddings
    if (openl3) {
      const embeddings = []
      for (const excerpt of excerpts) {
        const slots = Math.floor(excerpt.length / SAMPLE_RATE)
        const offsets = thin(Array.from({ length: Math.ceil(slots / EMBEDDING_STRIDE_SECONDS) }, (_, i) => i * EMBEDDING_STRIDE_SECONDS * SAMPLE_RATE), windows / FULL_WINDOWS)
        const result = await openl3.embed(excerpt, offsets)
        embeddings.push(...result.embeddings)
        timing.melMs += result.melMs
        timing.inferMs += result.inferMs
      }
      timing.windows = embeddings.length
      embedding = Buffer.from(meanEmbedding(embeddings).buffer).toString('base64')
      if (keepWindows) windowEmbeddings = embeddings.map(window => Buffer.from(window.buffer).toString('base64'))
    }
    await appendFile(outFile, `${JSON.stringify({ path, ...tags, features, embedding, windowEmbeddings, timing })}\n`)
    analysed++
  } catch (error) {
    console.error(`skipped ${path}: ${error.message}`)
  }
}

const cost = { shard, tracks: analysed, wallSeconds: (performance.now() - started) / 1000, peakRssMb: process.resourceUsage().maxRSS / KB_PER_MB, heapMb: process.memoryUsage().heapUsed / BYTES_PER_MB }
await writeFile(join(OUT_DIR, `${name}-${shard}.cost.json`), JSON.stringify(cost))
console.log(JSON.stringify(cost))

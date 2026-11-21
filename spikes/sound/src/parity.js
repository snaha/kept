// Checks the JS mel frontend and the WASM model against the PyTorch reference fixture
// written by convert/export-openl3.py, and times one forward pass.
import { readFile } from 'node:fs/promises'
import { loadOpenl3, SAMPLE_RATE } from './openl3.js'

const MODEL_DIR = new URL('../out/model', import.meta.url).pathname
const BENCH_RUNS = 5
// Usage: node src/parity.js [mels] [threads]
const mels = Number(process.argv[2] ?? 256)
const threads = Number(process.argv[3] ?? 1)
const f32 = async name => {
  const file = await readFile(`${MODEL_DIR}/${name}`)
  return new Float32Array(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength))
}
const maxAbsDiff = (a, b) => a.reduce((max, v, i) => Math.max(max, Math.abs(v - b[i])), 0)

const loadStart = performance.now()
const openl3 = await loadOpenl3(MODEL_DIR, { mels, threads })
console.log(`model load ${(performance.now() - loadStart).toFixed(0)} ms`)
const audio = await f32(`parity-mel${mels}-audio.f32`)
const referenceMel = await f32(`parity-mel${mels}-mel.f32`)
const referenceEmbedding = await f32(`parity-mel${mels}-embedding.f32`)
const mel = new Float32Array(referenceMel.length)
openl3.melSpectrogram(audio, 0, mel, 0)
console.log(`mel max abs diff ${maxAbsDiff(mel, referenceMel).toExponential(2)} dB`)
const { embeddings } = await openl3.embed(audio, [0])
console.log(`embedding max abs diff ${maxAbsDiff(embeddings[0], referenceEmbedding).toExponential(2)} (reference max ${Math.max(...referenceEmbedding).toFixed(2)})`)
const timing = await openl3.embed(audio, new Array(BENCH_RUNS).fill(0))
console.log(`mel${mels}, ${threads} thread(s), per 1 s window: mel ${(timing.melMs / BENCH_RUNS).toFixed(0)} ms, inference ${(timing.inferMs / BENCH_RUNS).toFixed(0)} ms, audio ${audio.length / SAMPLE_RATE} s`)
console.log(`rss ${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MB`)

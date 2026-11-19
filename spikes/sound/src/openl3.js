// OpenL3 (mel128 or mel256, music, 512-d) on onnxruntime-web WASM, single thread by default.
// The mel frontend follows kapre 0.1.4 as ported by torchopenl3: 48 kHz, 1 s windows,
// 2048-point periodic Hann STFT, hop 242, "same" padding, HTK mel basis taken from the weights,
// amplitude mel in decibels, referenced to the window maximum and floored at -80 dB.
import { readFile } from 'node:fs/promises'
import * as ort from 'onnxruntime-web'
import { createFft, hannWindow } from './fft.js'

export const SAMPLE_RATE = 48000
export const EMBEDDING_SIZE = 512
const N_FFT = 2048
const HOP = 242
const N_FRAMES = 199
const N_BINS = N_FFT / 2 + 1
const PAD_LEFT = Math.floor((N_FFT - (SAMPLE_RATE % HOP)) / 2)
const AMIN = 1e-10
const DYNAMIC_RANGE_DB = 80
const DB_SCALE = 10

/** Keeps an evenly spread share of the items: thin([0, 2, 4, 6, 8], 0.4) -> [2, 6]. */
export function thin(items, share) {
  const count = Math.max(1, Math.round(items.length * share))
  return Array.from({ length: count }, (_, i) => items[Math.round(((i + 0.5) * items.length) / count - 0.5)])
}

export async function loadOpenl3(modelDir, { mels = 256, threads = 1 } = {}) {
  const N_MELS = mels
  ort.env.wasm.numThreads = threads
  const session = await ort.InferenceSession.create(await readFile(`${modelDir}/openl3-mel${mels}-music-512.onnx`), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  })
  const basisFile = await readFile(`${modelDir}/openl3-mel${mels}-basis.f32`)
  const basis = new Float32Array(basisFile.buffer, basisFile.byteOffset, N_MELS * N_BINS)
  // Sparse rows: each mel filter touches a short run of bins.
  const filters = []
  for (let m = 0; m < N_MELS; m++) {
    let first = N_BINS
    let last = -1
    for (let b = 0; b < N_BINS; b++) {
      if (basis[m * N_BINS + b] !== 0) {
        first = Math.min(first, b)
        last = b
      }
    }
    filters.push({ first, weights: last < 0 ? new Float32Array(0) : basis.slice(m * N_BINS + first, m * N_BINS + last + 1) })
  }
  const fft = createFft(N_FFT)
  const window = hannWindow(N_FFT)
  const frame = new Float64Array(N_FFT)
  const power = new Float64Array(N_BINS)

  /** One second of 48 kHz mono audio -> decibel mel spectrogram, row-major [mels, 199]. */
  function melSpectrogram(audio, offset, out, outOffset) {
    let max = -Infinity
    for (let t = 0; t < N_FRAMES; t++) {
      const start = offset + t * HOP - PAD_LEFT
      for (let i = 0; i < N_FFT; i++) {
        const index = start + i
        frame[i] = index >= offset && index < offset + SAMPLE_RATE ? audio[index] : 0
      }
      fft.powerSpectrum(frame, window, power)
      for (let m = 0; m < N_MELS; m++) {
        const { first, weights } = filters[m]
        let sum = 0
        for (let i = 0; i < weights.length; i++) sum += weights[i] * power[first + i]
        const db = DB_SCALE * Math.log10(Math.max(Math.sqrt(sum), AMIN))
        out[outOffset + m * N_FRAMES + t] = db
        if (db > max) max = db
      }
    }
    for (let i = outOffset; i < outOffset + N_MELS * N_FRAMES; i++) out[i] = Math.max(out[i] - max, -DYNAMIC_RANGE_DB)
  }

  /** Embeds one-second windows starting at each offset; returns { embeddings, melMs, inferMs }. */
  async function embed(audio, offsets, batchSize = 1) {
    const embeddings = []
    let melMs = 0
    let inferMs = 0
    for (let i = 0; i < offsets.length; i += batchSize) {
      const batch = offsets.slice(i, i + batchSize)
      const input = new Float32Array(batch.length * N_MELS * N_FRAMES)
      const t0 = performance.now()
      batch.forEach((offset, j) => melSpectrogram(audio, offset, input, j * N_MELS * N_FRAMES))
      const t1 = performance.now()
      const result = await session.run({ melspectrogram: new ort.Tensor('float32', input, [batch.length, 1, N_MELS, N_FRAMES]) })
      inferMs += performance.now() - t1
      melMs += t1 - t0
      for (let j = 0; j < batch.length; j++) embeddings.push(Float32Array.from(result.embedding.data.subarray(j * EMBEDDING_SIZE, (j + 1) * EMBEDDING_SIZE)))
    }
    return { embeddings, melMs, inferMs }
  }

  return { embed, melSpectrogram }
}

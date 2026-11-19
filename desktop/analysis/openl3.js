// OpenL3 (music, 512-d) on onnxruntime-web WASM. The model is the ONNX export of the torchopenl3
// port (see scripts/export-openl3.py); weights CC BY 4.0, Cramer et al. 2019.
// The mel frontend follows kapre 0.1.4 as ported by torchopenl3: 48 kHz, 1 s windows,
// 2048-point periodic Hann STFT, hop 242, "same" padding, HTK mel basis taken from the weights,
// amplitude mel in decibels, referenced to the window maximum and floored at -80 dB.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { env, InferenceSession, Tensor } from 'onnxruntime-web'
import { createFft, hannWindow } from './fft.js'
import { EMBEDDING_SIZE, SAMPLE_RATE } from './methods.js'

const N_FFT = 2048
const HOP = 242
export const MEL_FRAMES = 199
const N_BINS = N_FFT / 2 + 1
const PAD_LEFT = Math.floor((N_FFT - (SAMPLE_RATE % HOP)) / 2)
const AMIN = 1e-10
const DYNAMIC_RANGE_DB = 80
const DB_SCALE = 10

/** The decibel mel spectrogram of one-second windows, from the mel basis of the weights. */
export function createMelFrontend(basis, mels) {
  // Sparse rows: each mel filter touches a short run of bins.
  const filters = []
  for (let m = 0; m < mels; m++) {
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
  /** One second of 48 kHz mono audio from `offset` -> row-major [mels, 199] written to `out`. */
  return function melSpectrogram(audio, offset, out) {
    let max = -Infinity
    for (let t = 0; t < MEL_FRAMES; t++) {
      const start = offset + t * HOP - PAD_LEFT
      for (let i = 0; i < N_FFT; i++) {
        const index = start + i
        frame[i] = index >= offset && index < offset + SAMPLE_RATE ? audio[index] : 0
      }
      fft.powerSpectrum(frame, window, power)
      for (let m = 0; m < mels; m++) {
        const { first, weights } = filters[m]
        let sum = 0
        for (let i = 0; i < weights.length; i++) sum += weights[i] * power[first + i]
        const db = DB_SCALE * Math.log10(Math.max(Math.sqrt(sum), AMIN))
        out[m * MEL_FRAMES + t] = db
        if (db > max) max = db
      }
    }
    for (let i = 0; i < mels * MEL_FRAMES; i++) out[i] = Math.max(out[i] - max, -DYNAMIC_RANGE_DB)
  }
}

export async function loadOpenl3Graph(bytes, mels) {
  // WASM fixes its thread pool at first initialization for the process.
  env.wasm.numThreads = 1
  const session = await InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
  const embedMel = async input => {
    const result = await session.run({ melspectrogram: new Tensor('float32', input, [1, 1, mels, MEL_FRAMES]) })
    const embedding = result.embedding
    if (embedding?.type !== 'float32' || embedding.dims.length !== 2 || embedding.dims[0] !== 1 || embedding.dims[1] !== EMBEDDING_SIZE) {
      throw new Error('Invalid OpenL3 embedding shape or type')
    }
    return Float32Array.from(embedding.data)
  }
  return { embedMel, release: () => session.release() }
}

/**
 * Loads the model of a method once. embed(audio, offset) -> Float32Array(512) for the one-second
 * window at `offset`. Calls are answered one at a time: a WASM session runs one inference at once.
 */
export async function loadOpenl3(modelDir, { model, mels }) {
  const basisFile = await readFile(path.join(modelDir, `${model.replace('-music-512', '')}-basis.f32`))
  const melSpectrogram = createMelFrontend(new Float32Array(basisFile.buffer.slice(basisFile.byteOffset, basisFile.byteOffset + mels * N_BINS * Float32Array.BYTES_PER_ELEMENT)), mels)
  const graph = await loadOpenl3Graph(await readFile(path.join(modelDir, `${model}.onnx`)), mels)
  let queue = Promise.resolve()
  const embed = (audio, offset) => {
    const answer = queue.then(async () => {
      const input = new Float32Array(mels * MEL_FRAMES)
      melSpectrogram(audio, offset, input)
      return graph.embedMel(input)
    })
    queue = answer.catch(() => {})
    return answer
  }
  return { embed, melSpectrogram, release: graph.release }
}

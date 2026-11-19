// The analysis methods: how a track is turned into an embedding and a feature vector. A method is
// named by `id` and `version`, and every stored feature carries both, so changing how features are
// computed is a new version (or a new id) and the old rows are simply computed again.
//   model      the OpenL3 export in the models folder: <model>.onnx and its mel basis
//   windows    one-second OpenL3 windows per track, spread over the excerpts
// Measured in B0 on 833 album tracks (docs/kept-intelligence-plan.md, "Cheaper OpenL3 settings").

export const DSP_VERSION = 1
// The order of the stored signal-processing vector. Changing it is a new DSP_VERSION.
export const DSP_SCALARS = Object.freeze([
  'loudnessDb', 'dynamicsDb', 'zcr', 'centroidHz', 'centroidStdHz', 'rolloffHz', 'flatness', 'highRatio', 'lowRatio', 'flux',
  'onsetRate', 'tempoBpm', 'tempoStrength', 'keyStrength', 'major', 'syllabicModulation',
])
export const DSP_VECTORS = Object.freeze(['mfccMean', 'mfccStd'])
export const MFCC_COUNT = 13
export const DSP_SIZE = DSP_SCALARS.length + DSP_VECTORS.length * MFCC_COUNT
export const EMBEDDING_SIZE = 512
export const SAMPLE_RATE = 48000

const EXCERPTS = Object.freeze({ excerptSeconds: 10, excerptPositions: Object.freeze([0.2, 0.5, 0.8]) })
const method = definition => Object.freeze({ ...EXCERPTS, dsp: DSP_VERSION, embeddingSize: EMBEDDING_SIZE, licence: 'CC-BY-4.0', ...definition })

export const ANALYSIS_METHODS = Object.freeze({
  // 80.2 % same-album retrieval, 4.3 s of inference per track.
  'openl3-mel128-w15': method({ id: 'openl3-mel128-w15', version: 1, model: 'openl3-mel128-music-512', mels: 128, windows: 15 }),
  // 82.2 %, 8.5 s: the reference, and the better one at finding the same artist on another album.
  'openl3-mel256-w15': method({ id: 'openl3-mel256-w15', version: 1, model: 'openl3-mel256-music-512', mels: 256, windows: 15 }),
  // 78.6 %, 3.4 s.
  'openl3-mel256-w6': method({ id: 'openl3-mel256-w6', version: 1, model: 'openl3-mel256-music-512', mels: 256, windows: 6 }),
  // 77.6 %, 1.7 s.
  'openl3-mel128-w6': method({ id: 'openl3-mel128-w6', version: 1, model: 'openl3-mel128-music-512', mels: 128, windows: 6 }),
})

// Decided after B0: the mel256 model finds the same artist on another album far better than mel128 (45 % against 34 %), at 3.4 s per track.
export const DEFAULT_METHOD_ID = 'openl3-mel256-w6'
// KEPT_ANALYSIS_METHOD picks another one, to compare them on a real library.
export const currentMethod = (env = process.env) => ANALYSIS_METHODS[env.KEPT_ANALYSIS_METHOD] ?? ANALYSIS_METHODS[DEFAULT_METHOD_ID]

/** The signal-processing summary as the stored vector, in DSP_SCALARS then DSP_VECTORS order. */
export function dspVector(features) {
  const vector = new Float32Array(DSP_SIZE)
  DSP_SCALARS.forEach((name, index) => { vector[index] = features[name] })
  DSP_VECTORS.forEach((name, block) => { for (let i = 0; i < MFCC_COUNT; i++) vector[DSP_SCALARS.length + block * MFCC_COUNT + i] = features[name][i] })
  for (let i = 0; i < vector.length; i++) if (!Number.isFinite(vector[i])) vector[i] = 0
  return vector
}
export const dspFeatures = vector => ({
  ...Object.fromEntries(DSP_SCALARS.map((name, index) => [name, vector[index]])),
  ...Object.fromEntries(DSP_VECTORS.map((name, block) => [name, Array.from(vector.subarray(DSP_SCALARS.length + block * MFCC_COUNT, DSP_SCALARS.length + (block + 1) * MFCC_COUNT))])),
})

// Float32 vectors cross process boundaries and the job queue as base64 text.
export const encodeVector = vector => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64')
export const decodeVector = text => {
  const bytes = Buffer.from(text, 'base64')
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

import { loadOpenl3Graph, MEL_FRAMES } from '../analysis/openl3.js'
import { EMBEDDING_SIZE } from '../analysis/methods.js'

// Compare every output component. Allow small floating-point differences from
// convolution kernels across architectures and equivalent ONNX exports.
const ABSOLUTE_TOLERANCE = 1e-3
const RELATIVE_TOLERANCE = 1e-4
const MIN_PROBE_SEPARATION = 0.1
const PROBE_SEED = 0x67a9e1dc
const LCG_MULTIPLIER = 1664525
const LCG_INCREMENT = 1013904223
const HIGH_BYTE_SHIFT = 24
const BYTE_VALUES = 256
const MEL_RANGE_DB = 80
const LOW_BAND_DIVISOR = 4
const LOW_BAND_DB = -8
const LOUD_STEP_DB = -16

// Exactly representable log-mel inputs exercise noise, frequency and time variation.
const PROBES = {
  noise: () => {
    let state = PROBE_SEED
    return () => {
      state = Math.imul(state, LCG_MULTIPLIER) + LCG_INCREMENT
      return -(state >>> HIGH_BYTE_SHIFT) * MEL_RANGE_DB / BYTE_VALUES
    }
  },
  'low-band': mels => index => Math.floor(index / MEL_FRAMES) < mels / LOW_BAND_DIVISOR ? LOW_BAND_DB : -MEL_RANGE_DB,
  'time-step': () => index => index % MEL_FRAMES < MEL_FRAMES / 2 ? LOUD_STEP_DB : -MEL_RANGE_DB,
}

export async function openl3Fingerprint(bytes, mels) {
  const graph = await loadOpenl3Graph(bytes, mels)
  try {
    const embeddings = {}
    for (const [name, probe] of Object.entries(PROBES)) {
      const sample = probe(mels)
      const input = Float32Array.from({ length: mels * MEL_FRAMES }, (_, index) => sample(index))
      embeddings[name] = await graph.embedMel(input)
    }
    return embeddings
  } finally {
    await graph.release()
  }
}

export async function verifyOpenl3Fingerprint(bytes, mels, expected) {
  const actual = Object.entries(await openl3Fingerprint(bytes, mels))
  for (const [name, embedding] of actual) {
    const reference = expected?.[name]
    if (!Array.isArray(reference) || reference.length !== EMBEDDING_SIZE || !reference.every(Number.isFinite)) {
      throw new Error(`Invalid OpenL3 reference embedding for ${name}`)
    }
    if (!embedding.every(Number.isFinite)) throw new Error(`Non-finite embedding for ${name}`)
  }
  for (const [index, [name, embedding]] of actual.entries()) {
    for (const [otherName, other] of actual.slice(0, index)) {
      const squaredDistance = embedding.reduce((sum, value, i) => sum + (value - other[i]) ** 2, 0)
      if (Math.sqrt(squaredDistance / EMBEDDING_SIZE) <= MIN_PROBE_SEPARATION) {
        throw new Error(`Embeddings for ${otherName} and ${name} are too similar`)
      }
    }
    for (const [component, value] of embedding.entries()) {
      const reference = expected[name][component]
      const tolerance = ABSOLUTE_TOLERANCE + RELATIVE_TOLERANCE * Math.abs(reference)
      if (Math.abs(value - reference) > tolerance) {
        throw new Error(`Embedding component ${component} for ${name}: expected ${reference} ± ${tolerance}, got ${value}`)
      }
    }
  }
}

import path from 'node:path'
import { createAnalyser } from '../analysis/analyser.js'
import { createDecoder } from '../analysis/decode.js'
import { DSP_SCALARS, MFCC_COUNT } from '../analysis/methods.js'

// The analyse handler with a fake decoder and a fake model, for tests of the job class in a real
// process. A file named `level-0.25.wav` decodes to audio whose every sample is 0.25, the model
// answers with that level in every dimension, and `silent` files decode to nothing.
const levelOf = file => Number(/level-(-?[\d.]+)\./.exec(path.basename(file))?.[1] ?? 0)

export default createAnalyser({
  decode: async request => {
    const { file, sampleRate, method } = request
    if (path.basename(file) === 'synthetic-retry.wav') return createDecoder(request.ffmpeg)(request)
    if (file.includes('silent')) return []
    if (file.includes('broken')) throw Object.assign(new Error('ffmpeg exited 1: invalid data'), { undecodable: true })
    return method.excerptPositions.map(() => new Float32Array(sampleRate * method.excerptSeconds).fill(levelOf(file)))
  },
  loadModel: async () => ({ embed: async (audio, offset) => new Float32Array(512).fill(audio[offset]) }),
  createDsp: () => ({
    analyse: excerpts => ({
      ...Object.fromEntries(DSP_SCALARS.map(name => [name, excerpts[0][0]])),
      mfccMean: new Array(MFCC_COUNT).fill(excerpts.length), mfccStd: new Array(MFCC_COUNT).fill(0),
    }),
  }),
})

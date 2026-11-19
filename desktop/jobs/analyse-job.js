import { createAnalyser } from '../analysis/analyser.js'
import { createDecoder } from '../analysis/decode.js'
import { createDsp } from '../analysis/dsp.js'
import { loadOpenl3 } from '../analysis/openl3.js'

// The sound of one track: an OpenL3 embedding and the signal-processing vector, from bounded excerpts.
// payload: { assetId, file, duration, method, ffmpeg, modelDir, analysisAllowed } (see analysis-jobs.js).
// The model loads once and stays for the life of this process.
export default createAnalyser({
  decode: request => createDecoder(request.ffmpeg)(request),
  loadModel: loadOpenl3,
  createDsp,
})

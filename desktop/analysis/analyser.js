// One track in, one embedding and one signal-processing vector out. The decoder, the model and the
// DSP are passed in, so the same code runs with the real ones in the analyser process and with
// fakes in tests.
//   decode({ ffmpeg, file, duration, method, sampleRate, signal, rest }) -> Float32Array[] (one per excerpt)
//   loadModel(modelDir, method) -> { embed(audio, offset) -> Float32Array }   loaded once per process and model
//   createDsp(sampleRate) -> { analyse(excerpts) -> features }
import { EMBEDDING_SIZE, SAMPLE_RATE, dspVector, encodeVector } from './methods.js'

const WINDOW_STRIDE_SECONDS = 2
const HALF_SLOT = 0.5
export const REFUSED_REASON = 'analysis-not-allowed'

/** Keeps an evenly spread share of the items: thin([0, 2, 4, 6, 8], 0.4) -> [2, 6]. */
function thin(items, share) {
  const count = Math.max(1, Math.min(items.length, Math.round(items.length * share)))
  return Array.from({ length: count }, (_, i) => items[Math.round(((i + HALF_SLOT) * items.length) / count - HALF_SLOT)])
}

/** The window offsets (in samples) inside each excerpt: every other second, thinned to `windows` in all. */
export function windowPlan(excerpts, windows, sampleRate = SAMPLE_RATE) {
  const slots = excerpts.map(excerpt => Array.from({ length: Math.ceil(Math.floor(excerpt.length / sampleRate) / WINDOW_STRIDE_SECONDS) }, (_, i) => i * WINDOW_STRIDE_SECONDS * sampleRate))
  const total = slots.reduce((sum, offsets) => sum + offsets.length, 0)
  const share = Math.min(1, windows / Math.max(total, 1))
  return slots.map(offsets => (offsets.length ? thin(offsets, share) : []))
}

export function createAnalyser({ decode, loadModel, createDsp, clock = () => performance.now() }) {
  let dsp
  // One session at a time. A change of model releases the old one before the new one loads.
  let current
  const modelOf = async (modelDir, method) => {
    const key = `${modelDir}:${method.model}`
    if (current?.key !== key) {
      const old = current
      current = undefined
      await (await old?.model)?.release?.()
      current = { key, model: loadModel(modelDir, method) }
      current.model.catch(() => { if (current?.key === key) current = undefined })
    }
    return current.model
  }
  // ctx: what a job handler gets (library-process-child.js).
  return async function analyse(ctx) {
    const { assetId, file, duration, method, ffmpeg, modelDir, analysisAllowed } = ctx.payload
    const about = { assetId, method: method?.id, version: method?.version }
    // The policy is checked where the job is enqueued and again where it is prepared. This is the last line.
    if (analysisAllowed !== true) return { ...about, outcome: 'refused', reason: REFUSED_REASON }
    if (!file) return { ...about, outcome: 'unavailable' }
    const started = clock()
    let excerpts
    try { excerpts = await decode({ ffmpeg, file, duration, method, sampleRate: SAMPLE_RATE, signal: ctx.signal, rest: ctx.rest }) } catch (error) {
      if (ctx.signal?.aborted) throw error
      if (error?.unavailable) return { ...about, outcome: 'unavailable', reason: error.message }
      if (!error?.undecodable) throw error
      return { ...about, outcome: 'unreadable', reason: error.message }
    }
    if (!excerpts.length) return { ...about, outcome: 'unreadable', reason: 'no audio decoded' }
    const decoded = clock()
    await ctx.rest()
    dsp ??= createDsp(SAMPLE_RATE)
    const features = dspVector(dsp.analyse(excerpts))
    const measured = clock()
    await ctx.rest()
    const model = await modelOf(modelDir, method)
    const loaded = clock()
    const mean = new Float32Array(EMBEDDING_SIZE)
    const plan = windowPlan(excerpts, method.windows)
    const windows = plan.reduce((sum, offsets) => sum + offsets.length, 0)
    for (const [index, offsets] of plan.entries()) {
      for (const offset of offsets) {
        if (ctx.signal?.aborted) throw new Error('Aborted')
        const embedding = await model.embed(excerpts[index], offset)
        for (let i = 0; i < EMBEDDING_SIZE; i++) mean[i] += embedding[i] / windows
        // Between windows is where playback gets the processor back.
        await ctx.rest()
      }
    }
    return {
      ...about, outcome: 'done', embedding: encodeVector(mean), dsp: encodeVector(features), windows,
      timing: { decodeMs: decoded - started, dspMs: measured - decoded, loadMs: loaded - measured, embedMs: clock() - loaded },
    }
  }
}

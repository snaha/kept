import { existsSync } from 'node:fs'
import path from 'node:path'
import { REFUSED_REASON } from './analysis/analyser.js'
import { currentMethod, decodeVector } from './analysis/methods.js'
import { folderSourceId } from './catalog-ingest.js'

// The `analyse` job class and the sweep that feeds it. The sweep walks every asset of the catalog and
// queues the ones the current method version has not analysed yet; features.sqlite is the only memory
// of what is done, so deleting it queues the whole library again.
//
// The policy of a source decides whether its audio may be analysed, and it is asked three times:
// when the sweep would enqueue (the refusal is recorded, nothing is queued), when the job is about to
// run (prepare, with the catalog as it is then) and in the analyser itself (the payload must say so).

export const ANALYSE_CLASS = 'analyse'
// Its own process: the model and the WASM runtime live there and nowhere else.
export const ANALYSE_PROCESS = 'analyser'
// Below hashing: identity comes before sound.
export const ANALYSE_PRIORITY = -10
export const ANALYSE_MODULE = new URL('./jobs/analyse-job.js', import.meta.url).href
const CANDIDATE_PAGE = 500

export const analyseSubject = (method, assetId) => `${method.id}@${method.version}:${assetId}`

// catalog: the catalog store (getAsset, getAlbum, analysisCandidates). features: the feature store.
// folders: () => the music folders. ffmpeg: the decoder's path, or undefined. modelDir: the models folder.
export function createAnalysis({ catalog, features, folders, ffmpeg, modelDir, method = currentMethod(), module = ANALYSE_MODULE, now = Date.now, exists = existsSync, onError }) {
  const key = { method: method.id, version: method.version }
  const modelFiles = [`${method.model}.onnx`, `${method.model.replace('-music-512', '')}-basis.f32`]
  const missing = !ffmpeg ? 'no audio decoder' : !modelFiles.every(name => existsSync(path.join(modelDir, name))) ? 'no sound model' : ''
  const refusal = assetId => ({ assetId, ...key, outcome: 'refused', reason: REFUSED_REASON })
  // The real file of an asset: an available location in a folder that is configured now.
  const roots = () => new Map(folders().map(folder => [folderSourceId(folder), folder]))
  const fileOf = asset => {
    const folderOf = roots()
    const location = asset.locations.find(candidate => candidate.availability === 'available' && folderOf.has(candidate.sourceId))
    return location && path.join(folderOf.get(location.sourceId), ...location.path.split('/'))
  }
  const sourceOf = asset => asset.locations.find(candidate => candidate.availability === 'available' && roots().has(candidate.sourceId))?.sourceId
  const aggregate = async albumId => {
    const { album } = await catalog.getAlbum({ albumId })
    if (album) await features.aggregateAlbums({ ...key, at: now(), albums: [{ albumId, assetIds: album.tracks.map(track => track.assetId) }] })
  }

  const jobClass = {
    name: ANALYSE_CLASS, process: ANALYSE_PROCESS, module, maxAttempts: 3, concurrency: 1, analysis: true,
    // Both run in the main process when the job is claimed, so they see the policy and the location as they are now.
    // skip: the jobs that end without the handler (superseded, gone, refused, file not there).
    async skip(job) {
      const { assetId } = job.payload
      if (job.payload.method !== method.id || job.payload.version !== method.version) return { assetId, outcome: 'superseded' }
      const { asset } = await catalog.getAsset({ assetId })
      if (!asset) return { assetId, ...key, outcome: 'gone' }
      if (!asset.analysisAllowed) return refusal(assetId)
      // A file that is not there now (a drive unplugged since the scan) waits for the next sweep. It is not unreadable.
      const file = fileOf(asset)
      if (!file || !exists(file)) return { assetId, ...key, outcome: 'unavailable' }
      return undefined
    },
    async prepare(job) {
      const { assetId } = job.payload
      const { asset } = await catalog.getAsset({ assetId })
      // The policy as it is now, not as it was at skip(): the analyser refuses when this is not true.
      return { assetId, file: asset && fileOf(asset), duration: asset?.duration, method, ffmpeg, modelDir, analysisAllowed: asset?.analysisAllowed === true }
    },
    async commit(job, result) {
      const at = now()
      if (result.outcome === 'done') {
        await features.putTrackFeatures({ ...key, assetId: result.assetId, embedding: decodeVector(result.embedding), dsp: decodeVector(result.dsp), windows: result.windows, at })
        const { asset } = await catalog.getAsset({ assetId: result.assetId })
        if (asset?.albumId) await aggregate(asset.albumId)
      } else if (result.outcome === 'refused' || result.outcome === 'unreadable') {
        await features.recordOutcome({ ...key, assetId: result.assetId, outcome: result.outcome, reason: result.reason, at })
      }
    },
    // The vectors are in features.sqlite; the queue keeps only how it went.
    receipt: ({ assetId, outcome, reason, windows, timing }) => JSON.parse(JSON.stringify({ assetId, outcome, reason, windows, timing })),
  }

  let running, again = false
  async function sweepOnce(worker, signal) {
    const stats = { assets: 0, queued: 0, refused: 0, unavailable: 0, settled: 0, albums: 0, ready: !missing, missing: missing || undefined }
    await features.registerMethod({ ...key, licence: method.licence, config: method })
    await features.pruneMethods({ keep: [key] })
    const albums = new Map()
    let after
    do {
      const page = await catalog.analysisCandidates({ after, limit: CANDIDATE_PAGE })
      const pending = new Set((await features.pendingAssets({ ...key, assetIds: page.assets.map(asset => asset.assetId) })).assetIds)
      const jobs = []
      for (const asset of page.assets) {
        stats.assets++
        if (asset.albumId) albums.set(asset.albumId, [...albums.get(asset.albumId) ?? [], asset.assetId])
        if (!asset.analysisAllowed) {
          // Also when it was analysed before the policy changed: the refusal removes those features.
          await features.recordOutcome({ ...refusal(asset.assetId), at: now() })
          stats.refused++
        } else if (!pending.has(asset.assetId)) stats.settled++
        else if (asset.availability !== 'available' || !fileOf(asset)) stats.unavailable++
        else jobs.push({ class: ANALYSE_CLASS, subject: analyseSubject(method, asset.assetId), priority: ANALYSE_PRIORITY, payload: { assetId: asset.assetId, sourceId: sourceOf(asset), ...key } })
      }
      if (jobs.length && !missing) {
        await worker.enqueue(jobs)
        stats.queued += jobs.length
      }
      after = page.next
    } while (after !== undefined && !signal?.aborted)
    if (!signal?.aborted) {
      await features.aggregateAlbums({ ...key, at: now(), complete: true, albums: [...albums].map(([albumId, assetIds]) => ({ albumId, assetIds })) })
      stats.albums = albums.size
    }
    return stats
  }

  return {
    method, jobClass, ready: !missing, missing,
    // One sweep at a time. A sweep asked for while one runs is run once more after it.
    sweep(worker, signal) {
      if (running) { again = true; return running }
      running = (async () => {
        try {
          let stats
          do { again = false; stats = await sweepOnce(worker, signal) } while (again && !signal?.aborted)
          return stats
        } catch (error) {
          onError?.(error)
          return undefined
        } finally { running = undefined }
      })()
      return running
    },
  }
}

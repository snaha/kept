import { folderSourceId } from './catalog-ingest.js'

// The main-process side of the `reconstruct` job class: what a job is handed when it starts, how
// its result is published, and which albums are queued.

export const RECONSTRUCT_CLASS = 'reconstruct'
const ENQUEUE_CHUNK = 500
// Below hashing: an album is reconstructed once its files are known.
export const RECONSTRUCT_PRIORITY = -10

// The cluster is read when the job is claimed, not when it was queued: a consent the user has
// since withdrawn, a lock or a later scan all count.
export async function prepareReconstruction(job, store, appVersion) {
  return { ...job.payload, appVersion, cluster: await store.reconstructionCluster({ albumId: job.payload.albumId }) }
}

// A stale result throws, so the queue retries the job and the ladder reads the album again.
export async function commitReconstruction(job, result, store, now = Date.now) {
  const stored = await store.storeReconstruction({ albumId: job.payload.albumId, result, now: now() })
  if (stored.status === 'stale') throw new Error('The album changed while it was being reconstructed')
  return stored
}

// worker: a LibraryWorker with the `reconstruct` class registered. store: the catalog store.
export function createReconstructJobs({ worker, store }) {
  return {
    interrupt: () => worker.interruptClass(RECONSTRUCT_CLASS),
    // Queues every album the ladder has not seen as it is now. Call after a scan was ingested and
    // after the user changed a consent: albums that were held back by it are among them.
    async enqueuePending({ folders = [] } = {}) {
      const roots = Object.fromEntries(folders.map(folder => [folderSourceId(folder), folder]))
      const { albumIds } = await store.reconstructionQueue({})
      const ids = []
      for (let at = 0; at < albumIds.length; at += ENQUEUE_CHUNK) {
        ids.push(...await worker.enqueue(albumIds.slice(at, at + ENQUEUE_CHUNK).map(albumId => ({
          class: RECONSTRUCT_CLASS, subject: albumId, payload: { albumId, roots }, priority: RECONSTRUCT_PRIORITY,
        }))))
      }
      return { albumIds, ids }
    },
  }
}

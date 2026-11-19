// The job classes of Kept. To add one: write a handler module in jobs/ (export default async ctx => result,
// see library-process-child.js), then add an entry here. Give a heavy class its own `process` name
// to keep it in a process of its own.
//   priority and maxAttempts are defaults for the jobs of the class
//   commit(job, result, store) runs in the main process just before the job is marked done
import { RECONSTRUCT_CLASS, commitReconstruction, prepareReconstruction } from './reconstruct-jobs.js'

export const createLibraryJobClasses = ({ onCatalogChange, appVersion } = {}) => [
  {
    name: 'hash', process: 'library', module: new URL('./jobs/hash-job.js', import.meta.url).href, maxAttempts: 3,
    // A replaced file has no result. Cache only the metadata of the version the worker read.
    commit(job, { contentHash, size, fileSize, modifiedMs, fileVersion }, store) {
      if (contentHash === undefined) return
      return store.storeFileHashes({
        sourceId: job.payload.sourceId,
        entries: [{ path: job.payload.path, contentHash, size, fileSize, modifiedMs, fileVersion }],
      })
    },
  },
  // The reconstruction ladder over one album (jobs/reconstruct-job.js). Its own process: it is the only class that may open a socket.
  {
    name: RECONSTRUCT_CLASS, process: 'reconstruct', module: new URL('./jobs/reconstruct-job.js', import.meta.url).href, maxAttempts: 4,
    prepare: (job, store) => prepareReconstruction(job, store, appVersion),
    async commit(job, result, store) {
      const stored = await commitReconstruction(job, result, store)
      if (stored.commits.some(commit => commit.status === 'applied' && !commit.replayed)) onCatalogChange?.()
      return stored
    },
  },
]

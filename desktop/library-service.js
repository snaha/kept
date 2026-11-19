import { createHashJobs } from './hash-jobs.js'
import { createLibraryJobClasses } from './library-job-classes.js'
import { LibraryWorker } from './library-worker.js'
import { ProcessExecutor } from './library-process.js'
import { createReconstructJobs } from './reconstruct-jobs.js'
import { ResourcePolicy } from './resource-policy.js'

const PLAYBACK_KINDS = ['state', 'track-start', 'stall']

// Everything background: the job queue's worker, the resource policy that puts playback first, and the
// scanner's hashing on top of them. store: the catalog store. fork: starts a worker process (see library-process.js).
export function createLibraryService({
  store, fork, onProgress, onError, onCatalogChange, appVersion, now = Date.now,
  policy = new ResourcePolicy({ now }), classes = createLibraryJobClasses({ onCatalogChange, appVersion }),
}) {
  const worker = new LibraryWorker({ store, classes, policy, now, onProgress, onError, executorFor: name => new ProcessExecutor({ fork, name }) })
  let decision = ''
  const key = snapshot => `${snapshot.mode}:${snapshot.dutyCycle}:${snapshot.concurrency}`
  return {
    worker, policy, hashJobs: createHashJobs(worker), reconstruct: createReconstructJobs({ worker, store }),
    start: () => worker.start(),
    stop: () => worker.stop(),
    status: () => worker.status(),
    // A report from the window about its audio element. Only a change in what work may run wakes the worker.
    reportPlayback(event) {
      if (!event || !PLAYBACK_KINDS.includes(event.kind)) return
      policy.report(event)
      const next = key(policy.snapshot())
      if (next !== decision) { decision = next; worker.wake() }
    },
    // The window went away: nothing is playing any more.
    playbackEnded() { this.reportPlayback({ kind: 'state', playing: false, waiting: false }) },
  }
}

import { createHashJobs } from './hash-jobs.js'
import { createLibraryJobClasses } from './library-job-classes.js'
import { LibraryWorker } from './library-worker.js'
import { ProcessExecutor } from './library-process.js'
import { createReconstructJobs } from './reconstruct-jobs.js'
import { ResourcePolicy } from './resource-policy.js'

const PLAYBACK_KINDS = ['state', 'track-start', 'stall']

// Everything background: the job queue's worker, the resource policy that puts playback first, and the
// scanner's hashing on top of them. store: the catalog store. fork: starts a worker process (see library-process.js).
// analysis: from createAnalysis (analysis-jobs.js), when sound analysis is part of this profile.
// idleMs: how long a worker process with nothing to do is kept (library-process.js).
export function createLibraryService({
  store, fork, onProgress, onError, onCatalogChange, appVersion, now = Date.now,
  policy = new ResourcePolicy({ now }), classes = createLibraryJobClasses({ onCatalogChange, appVersion }), analysis, idleMs,
}) {
  const worker = new LibraryWorker({ store, classes: analysis ? [...classes, analysis.jobClass] : classes, policy, now, onProgress, onError, executorFor: name => new ProcessExecutor({ fork, name, idleMs }) })
  let analysisPaused = false, restarting
  let decision = ''
  const key = snapshot => `${snapshot.mode}:${snapshot.dutyCycle}:${snapshot.concurrency}`
  return {
    worker, policy, hashJobs: createHashJobs(worker), reconstruct: createReconstructJobs({ worker, store }),
    start: () => worker.start(),
    stop: () => worker.stop(),
    status: () => worker.status(),
    // Queues every asset the current analysis method has not seen. Resolves with what it found.
    async analyse(signal) {
      while (restarting) await restarting.catch(() => {})
      if (!signal?.aborted) return analysis?.sweep(worker, signal)
    },
    // The user's controls for sound analysis. Pausing keeps the queue; the analysis picks up where it stopped.
    async pauseAnalysis(paused) {
      analysisPaused = paused
      if (analysis && !restarting) await worker.setClassPaused(analysis.jobClass.name, paused)
    },
    analysisCoverage: () => (analysis ? analysis.coverage() : Promise.resolve(undefined)),
    async restartAnalysis() {
      if (!analysis?.ready) throw new Error(`Sound analysis is unavailable${analysis?.missing ? `: ${analysis.missing}` : '.'}`)
      if (restarting) return restarting
      const name = analysis.jobClass.name
      restarting = (async () => {
        try {
          await worker.setClassPaused(name, true)
          return await analysis.restart(worker, onCatalogChange)
        } finally {
          // A pause or resume requested during the reset takes effect when the sweep ends.
          restarting = undefined
          await worker.setClassPaused(name, analysisPaused)
        }
      })()
      return restarting
    },
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

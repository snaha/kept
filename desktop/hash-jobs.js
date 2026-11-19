// The scanner's view of the `hash` job class: tell the queue which files need hashing, then ask for
// each result in the order the scanner reads them. Jobs outlive the scan: if Kept quits, the queue
// resumes them at the next launch. Each job belongs to one version of a file.

export const HASH_CLASS = 'hash'
const ENQUEUE_CHUNK = 500

// worker: a LibraryWorker with the `hash` class registered.
export function createHashJobs(worker) {
  const ids = new Map()
  const jobOf = payload => ({ class: HASH_CLASS, subject: JSON.stringify([payload.sourceId, payload.path, payload.fileVersion]), payload })
  return {
    // files: [{ sourceId, path, file, fileVersion }]
    async prefetch(files, signal) {
      ids.clear()
      for (let at = 0; at < files.length && !signal?.aborted; at += ENQUEUE_CHUNK) {
        const jobs = files.slice(at, at + ENQUEUE_CHUNK).map(jobOf)
        const jobIds = await worker.enqueue(jobs)
        jobs.forEach(({ subject }, index) => ids.set(subject, jobIds[index]))
      }
    },
    async hash(file, signal, { sourceId, path, fileVersion }) {
      if (signal?.aborted) throw new Error('Aborted')
      const job = jobOf({ sourceId, path, file, fileVersion })
      const id = ids.get(job.subject) ?? (await worker.enqueue([job]))[0]
      ids.delete(job.subject)
      const result = await worker.waitFor(id, signal)
      return result?.fileVersion === fileVersion ? result : undefined
    },
  }
}

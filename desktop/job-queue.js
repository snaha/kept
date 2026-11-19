// The persistent job queue inside library.sqlite. A job is one unit of background work: a class
// (which handler runs it), a subject (what it is about) and a JSON payload. There is one row per
// class and subject, so enqueueing again never creates a second live job. A worker leases a job
// for a while and renews the lease while it works; a lease that is not renewed (a crash, a
// restart) expires and the job is claimed again with its last checkpoint. All times are passed
// in by the caller, so the queue has no clock of its own.

export const JOB_STATES = Object.freeze(['queued', 'leased', 'done', 'failed'])
export const DEFAULT_MAX_ATTEMPTS = 3
export const BACKOFF_BASE_MS = 1000
export const BACKOFF_MAX_MS = 60000
export const DEFAULT_PRIORITY = 0
export const DONE_RETENTION_MS = 3600000
const BACKOFF_FACTOR = 2
const MAX_LIMIT = 100

export const JOB_METHODS = Object.freeze([
  'enqueueJobs', 'claimJobs', 'renewLease', 'saveCheckpoint', 'completeJob', 'failJob', 'releaseJob', 'recoverJobs',
  'retryFailedJobs', 'getJobs', 'jobCounts', 'pruneJobs',
])

// Entry for the MIGRATIONS list of catalog-store.js.
export const JOB_MIGRATION = `
  CREATE TABLE jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, class TEXT NOT NULL, subject TEXT NOT NULL, payload TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','leased','done','failed')), priority INTEGER NOT NULL, attempts INTEGER NOT NULL,
    max_attempts INTEGER NOT NULL, run_after INTEGER NOT NULL, lease_owner TEXT, lease_expires INTEGER, checkpoint TEXT, result TEXT,
    last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(class, subject)) STRICT;
  CREATE INDEX jobs_claim ON jobs(state, priority DESC, id);
`

// node:sqlite binds SQL NULL only from null and reads it back as null.
const SQL_NULL = null
const orUndefined = value => (value === SQL_NULL ? undefined : value)
const invalid = detail => new Error(`invalid-request: ${detail}`)
const isCount = value => Number.isSafeInteger(value) && value >= 0
const isText = value => typeof value === 'string' && value.length > 0
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const parse = text => (text === SQL_NULL ? undefined : JSON.parse(text))

export const backoffMs = attempts => Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * BACKOFF_FACTOR ** Math.max(0, attempts - 1))

const jobOf = row => ({
  id: row.id, class: row.class, subject: row.subject, payload: parse(row.payload), state: row.state, priority: row.priority,
  attempts: row.attempts, maxAttempts: row.max_attempts, runAfter: row.run_after, leaseOwner: orUndefined(row.lease_owner),
  leaseExpires: orUndefined(row.lease_expires), checkpoint: parse(row.checkpoint), result: parse(row.result), lastError: orUndefined(row.last_error),
  createdAt: row.created_at, updatedAt: row.updated_at,
})

// store: a CatalogStore (run, get, all, transaction).
export class JobQueue {
  constructor(store) { this.store = store }

  // One live job per class and subject: a job that is queued or leased is returned as it is.
  // A finished or failed one starts over with the new payload.
  enqueueJobs({ jobs, now }) {
    if (!Array.isArray(jobs) || !isCount(now)) throw invalid('jobs')
    const { store } = this
    return store.transaction(() => ({
      ids: jobs.map(job => {
        if (!isObject(job) || !isText(job.class) || !isText(job.subject) || !isObject(job.payload)
          || (job.priority !== undefined && !Number.isSafeInteger(job.priority)) || (job.maxAttempts !== undefined && !(Number.isSafeInteger(job.maxAttempts) && job.maxAttempts > 0))) throw invalid('job')
        const priority = job.priority ?? DEFAULT_PRIORITY, maxAttempts = job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, payload = JSON.stringify(job.payload)
        store.run(`INSERT INTO jobs(class, subject, payload, state, priority, attempts, max_attempts, run_after, created_at, updated_at) VALUES(?,?,?,'queued',?,0,?,?,?,?)
          ON CONFLICT(class, subject) DO UPDATE SET payload=excluded.payload, state='queued', priority=excluded.priority, attempts=0, max_attempts=excluded.max_attempts,
            run_after=excluded.run_after, lease_owner=NULL, lease_expires=NULL, checkpoint=NULL, result=NULL, last_error=NULL, updated_at=excluded.updated_at
          WHERE jobs.state IN ('done','failed')`, job.class, job.subject, payload, priority, maxAttempts, now, now, now)
        return store.get('SELECT id FROM jobs WHERE class=? AND subject=?', job.class, job.subject).id
      }),
    }))
  }

  // Leases up to limit jobs: queued ones that are due, and leased ones whose lease has expired
  // (their worker is gone). A job that keeps losing its worker is failed instead of retried forever.
  // waitMs is how long until something else becomes claimable.
  claimJobs({ owner, classes, limit, leaseMs, now }) {
    if (!isText(owner) || !Array.isArray(classes) || !classes.every(isText) || !Number.isSafeInteger(limit) || limit < 0 || limit > MAX_LIMIT || !(leaseMs > 0) || !isCount(now)) throw invalid('claim')
    const { store } = this
    if (!classes.length) return { jobs: [] }
    const marks = classes.map(() => '?').join(',')
    return store.transaction(() => {
      store.run(`UPDATE jobs SET state='failed', lease_owner=NULL, lease_expires=NULL, last_error='The worker stopped too many times', updated_at=?
        WHERE state='leased' AND lease_expires<=? AND attempts>=max_attempts`, now, now)
      const due = limit ? store.all(`SELECT * FROM jobs WHERE class IN (${marks}) AND ((state='queued' AND run_after<=?) OR (state='leased' AND lease_expires<=?))
        ORDER BY priority DESC, id LIMIT ?`, ...classes, now, now, limit) : []
      const jobs = due.map(row => {
        store.run("UPDATE jobs SET state='leased', lease_owner=?, lease_expires=?, attempts=attempts+1, updated_at=? WHERE id=?", owner, now + leaseMs, now, row.id)
        return jobOf(store.get('SELECT * FROM jobs WHERE id=?', row.id))
      })
      const next = store.get(`SELECT min(CASE state WHEN 'queued' THEN run_after ELSE lease_expires END) AS at FROM jobs
        WHERE class IN (${marks}) AND ((state='queued' AND run_after>?) OR (state='leased' AND lease_expires>?))`, ...classes, now, now)
      return { jobs, waitMs: next.at === SQL_NULL ? undefined : next.at - now }
    })
  }

  // The owner of a lease extends it, optionally with a checkpoint to resume from. ok is false once
  // the job is no longer leased to the owner: someone else claimed it, and the owner must stop.
  renewLease({ id, owner, leaseMs, now, checkpoint }) {
    if (!isCount(id) || !isText(owner) || !(leaseMs > 0) || !isCount(now)) throw invalid('lease')
    const { store } = this
    const { changes } = checkpoint === undefined
      ? store.run("UPDATE jobs SET lease_expires=?, updated_at=? WHERE id=? AND state='leased' AND lease_owner=?", now + leaseMs, now, id, owner)
      : store.run("UPDATE jobs SET lease_expires=?, checkpoint=?, updated_at=? WHERE id=? AND state='leased' AND lease_owner=?", now + leaseMs, JSON.stringify(checkpoint), now, id, owner)
    return { ok: changes > 0 }
  }
  saveCheckpoint(request) { return this.renewLease(request) }

  completeJob({ id, owner, result, now }) {
    if (!isCount(id) || !isText(owner) || !isCount(now)) throw invalid('complete')
    const { changes } = this.store.run("UPDATE jobs SET state='done', result=?, checkpoint=NULL, lease_owner=NULL, lease_expires=NULL, last_error=NULL, updated_at=? WHERE id=? AND state='leased' AND lease_owner=?",
      result === undefined ? SQL_NULL : JSON.stringify(result), now, id, owner)
    return { ok: changes > 0 }
  }

  // A failed attempt is retried after a backoff until the job has used its attempts, then it stays failed.
  failJob({ id, owner, error, now }) {
    if (!isCount(id) || !isText(owner) || !isCount(now)) throw invalid('fail')
    const { store } = this
    return store.transaction(() => {
      const row = store.get("SELECT attempts, max_attempts FROM jobs WHERE id=? AND state='leased' AND lease_owner=?", id, owner)
      if (!row) return { ok: false }
      const state = row.attempts >= row.max_attempts ? 'failed' : 'queued', runAfter = now + backoffMs(row.attempts)
      store.run('UPDATE jobs SET state=?, run_after=?, lease_owner=NULL, lease_expires=NULL, last_error=?, updated_at=? WHERE id=?', state, runAfter, String(error ?? 'Failed').slice(0, 500), now, id)
      return { ok: true, state, runAfter }
    })
  }

  // A clean stop: the job goes back to the queue at once, and the attempt it was given is returned.
  releaseJob({ id, owner, checkpoint, now }) {
    if (!isCount(id) || !isText(owner) || !isCount(now)) throw invalid('release')
    const { store } = this
    const { changes } = store.run(`UPDATE jobs SET state='queued', attempts=max(attempts-1,0), lease_owner=NULL, lease_expires=NULL, run_after=?,
      checkpoint=coalesce(?, checkpoint), updated_at=? WHERE id=? AND state='leased' AND lease_owner=?`, now, checkpoint === undefined ? SQL_NULL : JSON.stringify(checkpoint), now, id, owner)
    return { ok: changes > 0 }
  }

  // Called once when the library worker starts, while Kept holds the profile's single-instance lock:
  // every lease belongs to a worker that no longer exists, so they all expire now.
  recoverJobs({ now }) {
    if (!isCount(now)) throw invalid('recover')
    return { recovered: this.store.run("UPDATE jobs SET lease_expires=?, updated_at=? WHERE state='leased'", now, now).changes }
  }

  retryFailedJobs({ class: jobClass, now }) {
    if (!isCount(now) || (jobClass !== undefined && !isText(jobClass))) throw invalid('retry')
    const sql = "UPDATE jobs SET state='queued', attempts=0, run_after=?, updated_at=? WHERE state='failed'"
    return { retried: (jobClass === undefined ? this.store.run(sql, now, now) : this.store.run(`${sql} AND class=?`, now, now, jobClass)).changes }
  }

  getJobs({ ids }) {
    if (!Array.isArray(ids) || !ids.every(isCount) || ids.length > MAX_LIMIT * MAX_LIMIT) throw invalid('ids')
    return { jobs: ids.map(id => this.store.get('SELECT * FROM jobs WHERE id=?', id)).filter(Boolean).map(jobOf) }
  }

  jobCounts() {
    const counts = {}
    for (const row of this.store.all('SELECT class, state, count(*) AS n FROM jobs GROUP BY class, state')) counts[row.class] = { ...counts[row.class], [row.state]: row.n }
    return { counts }
  }

  // Finished jobs only keep their result for a while.
  pruneJobs({ before }) {
    if (!isCount(before)) throw invalid('prune')
    return { pruned: this.store.run("DELETE FROM jobs WHERE state='done' AND updated_at<?", before).changes }
  }
}

import { randomUUID } from 'node:crypto'
import { DONE_RETENTION_MS } from './job-queue.js'

// The library worker: it claims jobs from the persistent queue, hands them to an executor, keeps their
// leases alive, and records how each one ended. It does no heavy work itself (that runs in the
// executor's process) and its concurrency is whatever the resource policy allows right now.
//
// A job class is { name, process, module, maxAttempts?, commit? }:
//   process  names the executor process the class runs in. Classes with the same name share one
//            process; give a heavy class (model inference) its own name to isolate it.
//   module   file URL of the handler: export default async ctx => result (see library-process-child.js)
//   prepare  optional async (job, store) -> payload, run in the main process when the job is claimed, to
//            hand the handler what the catalog holds now instead of what it held when the job was queued.
//   commit   optional async (job, result, store) run in the main process before the job is completed,
//            to put the result where the rest of Kept reads it.
//
// executorFor(processName) -> { run(job, { module, onCheckpoint }) -> Promise<result>, abort(id), setGate(snapshot), close() }

export const LEASE_MS = 30000
export const IDLE_POLL_MS = 5000
export const MIN_POLL_MS = 50
export const PROGRESS_INTERVAL_MS = 200
const LEASE_RENEWALS_PER_LEASE = 3
const PRUNE_EVERY = 200

export class LibraryWorker {
  constructor({ store, classes, executorFor, policy, now = Date.now, owner = `worker:${randomUUID()}`, leaseMs = LEASE_MS, setTimer = setTimeout, clearTimer = clearTimeout, onProgress, onError }) {
    this.store = store
    this.classes = new Map(classes.map(definition => [definition.name, definition]))
    this.executorFor = executorFor
    this.policy = policy
    this.now = now
    this.owner = owner
    this.leaseMs = leaseMs
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.onProgress = onProgress
    this.onError = onError
    this.running = new Map()
    this.waiters = new Map()
    this.executors = new Map()
    this.finished = {}
    this.gate = undefined
    this.stopped = true
    this.pumping = false
    this.again = false
    this.settled = 0
    this.notified = 0
  }

  async start() {
    this.stopped = false
    await this.store.recoverJobs({ now: this.now() })
    await this.store.pruneJobs({ before: this.now() - DONE_RETENTION_MS })
    this.wake()
  }

  // Adds jobs (see enqueueJobs in job-queue.js). A job that is already queued or running is not added twice.
  async enqueue(jobs) {
    for (const job of jobs) if (!this.classes.has(job.class)) throw new Error(`Unknown job class: ${job.class}`)
    const defaults = jobs.map(job => ({ maxAttempts: this.classes.get(job.class).maxAttempts, ...job }))
    const { ids } = await this.store.enqueueJobs({ jobs: defaults, now: this.now() })
    this.wake()
    return ids
  }

  // Resolves with the result of the job, rejects if it fails for good or the signal aborts.
  waitFor(id, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('Aborted')); return }
      const onAbort = () => {
        this.waiters.set(id, (this.waiters.get(id) ?? []).filter(item => item !== waiter))
        reject(new Error('Aborted'))
      }
      // The signal outlives the wait: the listener goes when the wait ends either way.
      const waiter = { resolve, reject, detach: () => signal?.removeEventListener('abort', onAbort) }
      const list = this.waiters.get(id) ?? []
      this.waiters.set(id, [...list, waiter])
      signal?.addEventListener('abort', onAbort, { once: true })
      // It may have ended before anyone listened.
      void this.store.getJobs({ ids: [id] }).then(({ jobs: [job] }) => {
        if (job?.state === 'done') this.settle(id, 'resolve', job.result)
        else if (job?.state === 'failed') this.settle(id, 'reject', new Error(job.lastError ?? 'The job failed'))
      }).catch(() => {})
    })
  }
  settle(id, how, value) {
    const list = this.waiters.get(id)
    if (!list) return
    this.waiters.delete(id)
    for (const waiter of list) { waiter.detach?.(); waiter[how](value) }
  }

  // Call after the policy changed, or when the queue may hold something new.
  wake() {
    if (this.stopped) return
    if (this.pumping) { this.again = true; return }
    this.clearTimer(this.timer)
    this.timer = undefined
    void this.pump()
  }

  async pump() {
    this.pumping = true
    try {
      do {
        this.again = false
        const snapshot = this.policy.snapshot()
        this.pushGate(snapshot)
        let waitMs = snapshot.holdMs || undefined
        // Jobs claimed while idle must not all keep running once playback shrinks the allowance.
        if (snapshot.mode !== 'hold') await this.shed(snapshot.concurrency)
        const room = snapshot.concurrency - this.running.size
        const claimed = await this.store.claimJobs({ owner: this.owner, classes: [...this.classes.keys()], limit: Math.max(0, room), leaseMs: this.leaseMs, now: this.now() })
        if (this.stopped) {
          for (const job of claimed.jobs) await this.store.releaseJob({ id: job.id, owner: this.owner, now: this.now() })
          return
        }
        for (const job of claimed.jobs) this.execute(job)
        if (claimed.waitMs !== undefined) waitMs = Math.min(waitMs ?? Infinity, claimed.waitMs)
        this.nextWake = waitMs
      } while (this.again && !this.stopped)
    } catch (error) { this.onError?.(error) }
    finally { this.pumping = false }
    if (this.stopped) return
    const live = this.running.size > 0 || (await this.liveJobs().catch(() => 0)) > 0
    this.clearTimer(this.timer)
    // A hold or a backoff ends by the clock; otherwise the poll only catches leases that expired.
    if (live || this.nextWake !== undefined) this.timer = this.setTimer(() => this.wake(), Math.max(MIN_POLL_MS, Math.min(this.nextWake ?? IDLE_POLL_MS, IDLE_POLL_MS)))
    this.progress()
  }

  // Gives the newest running jobs back to the queue, without losing an attempt, until `limit` remain.
  async shed(limit) {
    const excess = [...this.running.values()].slice(Math.max(0, limit))
    for (const entry of excess) await this.releaseRunning(entry)
  }

  async interruptClass(name) {
    const jobs = [...this.running.values()].filter(entry => entry.job.class === name)
    await Promise.all(jobs.map(entry => this.releaseRunning(entry)))
    this.wake()
  }

  async releaseRunning(entry) {
    this.lose(entry)
    clearInterval(entry.lease)
    this.running.delete(entry.job.id)
    await entry.checkpoints
    await this.store.releaseJob({ id: entry.job.id, owner: this.owner, now: this.now() }).catch(() => {})
  }

  async liveJobs() {
    const { counts } = await this.store.jobCounts()
    return Object.values(counts).reduce((sum, state) => sum + (state.queued ?? 0) + (state.leased ?? 0), 0)
  }

  pushGate(snapshot) {
    const key = `${snapshot.mode}:${snapshot.dutyCycle}`
    if (key === this.gate) return
    this.gate = key
    for (const executor of this.executors.values()) executor.setGate(snapshot)
  }
  executor(name) {
    let executor = this.executors.get(name)
    if (!executor) {
      executor = this.executorFor(name)
      executor.setGate(this.policy.snapshot())
      this.executors.set(name, executor)
    }
    return executor
  }

  execute(job) {
    const definition = this.classes.get(job.class)
    const entry = { job, lease: undefined, checkpoints: Promise.resolve(), lost: false }
    this.running.set(job.id, entry)
    entry.lease = setInterval(() => void this.renew(entry), this.leaseMs / LEASE_RENEWALS_PER_LEASE)
    entry.lease.unref?.()
    const executor = this.executor(definition.process)
    void (async () => {
      try {
        const prepared = definition.prepare ? { ...job, payload: await definition.prepare(job, this.store) } : job
        if (entry.lost || this.stopped) return
        const result = await executor.run(prepared, {
          module: definition.module,
          onCheckpoint: checkpoint => { entry.checkpoints = entry.checkpoints.then(() => this.renewWith(entry, checkpoint)).catch(() => {}) },
        })
        await entry.checkpoints
        if (entry.lost || this.stopped) return
        await definition.commit?.(job, result, this.store)
        if ((await this.store.completeJob({ id: job.id, owner: this.owner, result, now: this.now() })).ok) {
          this.count(job.class, 'done')
          this.settle(job.id, 'resolve', result)
        }
      } catch (error) {
        await entry.checkpoints
        if (entry.lost || this.stopped) return
        const message = error?.message ?? String(error)
        const failure = await this.store.failJob({ id: job.id, owner: this.owner, error: message, now: this.now() }).catch(() => ({ ok: false }))
        if (failure.ok && failure.state === 'failed') {
          this.count(job.class, 'failed')
          this.settle(job.id, 'reject', new Error(message))
        }
        if (failure.ok) this.onError?.(new Error(`${job.class} ${job.subject}: ${message}`), { job, retry: failure.state === 'queued' })
      } finally {
        clearInterval(entry.lease)
        if (this.running.get(job.id) === entry) this.running.delete(job.id)
        this.wake()
      }
    })()
  }

  async renewWith(entry, checkpoint) {
    const { ok } = await this.store.renewLease({ id: entry.job.id, owner: this.owner, leaseMs: this.leaseMs, now: this.now(), checkpoint })
    if (!ok) this.lose(entry)
  }
  async renew(entry) {
    try { await this.renewWith(entry) } catch (error) { this.onError?.(error) }
  }
  // Another worker owns the job now: stop it and drop whatever it produces.
  lose(entry) {
    if (entry.lost || this.running.get(entry.job.id) !== entry) return
    entry.lost = true
    this.executor(this.classes.get(entry.job.class).process).abort(entry.job.id)
  }

  count(jobClass, outcome) {
    const finished = this.finished[jobClass] ??= { done: 0, failed: 0 }
    finished[outcome]++
    if (++this.settled % PRUNE_EVERY === 0) void this.store.pruneJobs({ before: this.now() - DONE_RETENTION_MS }).catch(() => {})
    this.progress()
  }

  // What is queued, running and finished since the queue was last empty, per class, for the window.
  async status() {
    const { counts } = await this.store.jobCounts()
    const classes = {}
    for (const [name, states] of Object.entries(counts)) {
      const finished = this.finished[name] ?? { done: 0, failed: 0 }
      const queued = states.queued ?? 0, running = states.leased ?? 0
      if (queued + running + finished.done + finished.failed) classes[name] = { queued, running, done: finished.done, failed: finished.failed }
    }
    const live = Object.values(classes).some(entry => entry.queued + entry.running > 0)
    if (!live) this.finished = {}
    return { mode: this.policy.snapshot().mode, classes }
  }
  progress() {
    if (!this.onProgress) return
    const at = this.now()
    if (at - this.notified < PROGRESS_INTERVAL_MS) {
      if (!this.progressTimer) this.progressTimer = this.setTimer(() => { this.progressTimer = undefined; this.progress() }, PROGRESS_INTERVAL_MS)
      return
    }
    this.notified = at
    void this.status().then(status => this.onProgress(status)).catch(() => {})
  }

  // Running jobs are interrupted and go back to the queue without losing an attempt.
  async stop() {
    this.stopped = true
    this.clearTimer(this.timer)
    this.clearTimer(this.progressTimer)
    const entries = [...this.running.values()]
    for (const entry of entries) clearInterval(entry.lease)
    for (const executor of this.executors.values()) await executor.close()
    this.executors.clear()
    for (const entry of entries) {
      await entry.checkpoints
      await this.store.releaseJob({ id: entry.job.id, owner: this.owner, now: this.now() }).catch(() => {})
    }
    this.running.clear()
    for (const id of [...this.waiters.keys()]) this.settle(id, 'reject', new Error('Stopped'))
  }
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CatalogStore } from './catalog-store.js'
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, DEFAULT_MAX_ATTEMPTS, backoffMs } from './job-queue.js'

const T0 = 1000000
const LEASE = 30000
const SECOND = 1000
const WORKER_A = 'worker:a', WORKER_B = 'worker:b'
const HASH = 'hash'
const temporary = t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'kept-jobs-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return path.join(directory, 'library.sqlite')
}
const open = (t, file = temporary(t)) => {
  const store = new CatalogStore(file)
  t.after(() => { try { store.close() } catch { /* already closed by the test */ } })
  return { store, file }
}
const enqueue = (store, jobs, now = T0) => store.call('enqueueJobs', { jobs, now }).ids
const claim = (store, owner, now, extra = {}) => store.call('claimJobs', { owner, classes: [HASH, 'analyse'], limit: 10, leaseMs: LEASE, now, ...extra })
const job = (subject, extra = {}) => ({ class: HASH, subject, payload: { file: subject }, ...extra })

test('enqueue is idempotent: one live job per class and subject', t => {
  const { store } = open(t)
  const [first] = enqueue(store, [job('a', { payload: { file: 'first' } })])
  const [again] = enqueue(store, [job('a', { payload: { file: 'second' } })], T0 + SECOND)
  assert.equal(again, first)
  assert.deepEqual(store.call('jobCounts').counts, { hash: { queued: 1 } })
  assert.deepEqual(claim(store, WORKER_A, T0 + SECOND).jobs[0].payload, { file: 'first' }, 'a live job keeps its payload')
  assert.equal(enqueue(store, [job('a')], T0 + 2 * SECOND)[0], first, 'a leased job is live too')
  assert.equal(store.call('jobCounts').counts.hash.leased, 1)
  // The same subject in another class is another job.
  assert.notEqual(enqueue(store, [{ class: 'analyse', subject: 'a', payload: {} }])[0], first)
})

test('a finished or failed job starts over when it is enqueued again', t => {
  const { store } = open(t)
  const [id] = enqueue(store, [job('a')])
  const [{ attempts }] = claim(store, WORKER_A, T0).jobs
  assert.equal(attempts, 1)
  store.call('saveCheckpoint', { id, owner: WORKER_A, leaseMs: LEASE, now: T0, checkpoint: { at: 5 } })
  assert.deepEqual(store.call('completeJob', { id, owner: WORKER_A, result: { contentHash: 'h' }, now: T0 + SECOND }), { ok: true })
  assert.deepEqual(store.call('getJobs', { ids: [id] }).jobs[0].result, { contentHash: 'h' })
  assert.equal(enqueue(store, [job('a', { payload: { file: 'changed' } })], T0 + 2 * SECOND)[0], id)
  const [again] = claim(store, WORKER_A, T0 + 2 * SECOND).jobs
  assert.deepEqual([again.attempts, again.payload, again.checkpoint, again.result], [1, { file: 'changed' }, undefined, undefined])
})

test('jobs are claimed by priority, then in the order they were added, up to the limit', t => {
  const { store } = open(t)
  enqueue(store, [job('low-1', { priority: -1 }), job('normal-1'), job('high', { priority: 5 }), job('normal-2')])
  assert.deepEqual(claim(store, WORKER_A, T0, { limit: 3 }).jobs.map(item => item.subject), ['high', 'normal-1', 'normal-2'])
  assert.deepEqual(claim(store, WORKER_A, T0, { limit: 3 }).jobs.map(item => item.subject), ['low-1'])
  assert.deepEqual(claim(store, WORKER_A, T0).jobs, [])
  assert.deepEqual(claim(store, WORKER_A, T0, { classes: [] }).jobs, [])
})

test('a lease that expires is claimed again, and the old owner can no longer finish the job', t => {
  const { store } = open(t)
  const [id] = enqueue(store, [job('a')])
  claim(store, WORKER_A, T0)
  assert.deepEqual(claim(store, WORKER_B, T0 + LEASE - 1), { jobs: [], waitMs: 1 }, 'a live lease is respected')
  const renewed = store.call('renewLease', { id, owner: WORKER_A, leaseMs: LEASE, now: T0 + LEASE - 1 })
  assert.deepEqual(renewed, { ok: true })
  assert.equal(claim(store, WORKER_B, T0 + LEASE + 1).jobs.length, 0, 'renewing moved the expiry')
  const [taken] = claim(store, WORKER_B, T0 + 2 * LEASE).jobs
  assert.deepEqual([taken.id, taken.attempts, taken.leaseOwner], [id, 2, WORKER_B])
  assert.deepEqual(store.call('renewLease', { id, owner: WORKER_A, leaseMs: LEASE, now: T0 + 2 * LEASE }), { ok: false })
  assert.deepEqual(store.call('completeJob', { id, owner: WORKER_A, result: {}, now: T0 + 2 * LEASE }), { ok: false })
  assert.deepEqual(store.call('failJob', { id, owner: WORKER_A, error: 'late', now: T0 + 2 * LEASE }), { ok: false })
  assert.deepEqual(store.call('completeJob', { id, owner: WORKER_B, result: {}, now: T0 + 2 * LEASE }), { ok: true })
})

test('after a crash and restart the job resumes from its last checkpoint', t => {
  const { store, file } = open(t)
  const [id] = enqueue(store, [job('a')])
  claim(store, WORKER_A, T0)
  store.call('saveCheckpoint', { id, owner: WORKER_A, leaseMs: LEASE, now: T0 + SECOND, checkpoint: { done: 40 } })
  store.call('saveCheckpoint', { id, owner: WORKER_A, leaseMs: LEASE, now: T0 + 2 * SECOND, checkpoint: { done: 70 } })
  // The process dies here: nothing releases the lease. The file is opened again by the next run.
  store.close()
  const { store: restarted } = open(t, file)
  assert.equal(restarted.call('jobCounts').counts.hash.leased, 1, 'the lease survived the restart')
  assert.deepEqual(restarted.call('recoverJobs', { now: T0 + 3 * SECOND }), { recovered: 1 })
  const [resumed] = claim(restarted, WORKER_B, T0 + 3 * SECOND).jobs
  assert.deepEqual([resumed.id, resumed.checkpoint, resumed.attempts], [id, { done: 70 }, 2])
})

test('a failed attempt is retried after a backoff that grows, until the attempts run out', t => {
  const { store } = open(t)
  const [id] = enqueue(store, [job('a')])
  let now = T0
  for (let attempt = 1; attempt <= DEFAULT_MAX_ATTEMPTS; attempt++) {
    const [{ attempts }] = claim(store, WORKER_A, now).jobs
    assert.equal(attempts, attempt)
    const failure = store.call('failJob', { id, owner: WORKER_A, error: `boom ${attempt}`, now })
    if (attempt === DEFAULT_MAX_ATTEMPTS) {
      assert.deepEqual(failure, { ok: true, state: 'failed', runAfter: now + backoffMs(attempt) })
      break
    }
    assert.deepEqual(failure, { ok: true, state: 'queued', runAfter: now + backoffMs(attempt) })
    const waiting = claim(store, WORKER_A, now + backoffMs(attempt) - 1)
    assert.deepEqual(waiting, { jobs: [], waitMs: 1 }, 'not before the backoff is over')
    now += backoffMs(attempt)
  }
  const [failed] = store.call('getJobs', { ids: [id] }).jobs
  assert.deepEqual([failed.state, failed.lastError], ['failed', 'boom 3'])
  assert.deepEqual(claim(store, WORKER_A, now + BACKOFF_MAX_MS).jobs, [], 'a failed job stays failed')
  assert.deepEqual(store.call('retryFailedJobs', { now }), { retried: 1 })
  assert.equal(claim(store, WORKER_A, now).jobs[0].attempts, 1)
  assert.deepEqual([backoffMs(1), backoffMs(2), backoffMs(3), backoffMs(30)], [BACKOFF_BASE_MS, 2 * BACKOFF_BASE_MS, 4 * BACKOFF_BASE_MS, BACKOFF_MAX_MS])
})

test('a job whose worker keeps dying is failed instead of claimed forever', t => {
  const { store } = open(t)
  const [id] = enqueue(store, [job('poison')])
  let now = T0
  for (let attempt = 1; attempt <= DEFAULT_MAX_ATTEMPTS; attempt++) {
    assert.equal(claim(store, `worker:${attempt}`, now).jobs[0].attempts, attempt)
    now += 2 * LEASE
  }
  assert.deepEqual(claim(store, WORKER_B, now).jobs, [])
  const [poisoned] = store.call('getJobs', { ids: [id] }).jobs
  assert.deepEqual([poisoned.state, poisoned.lastError], ['failed', 'The worker stopped too many times'])
})

test('a clean stop gives the job back to the queue with its attempt', t => {
  const { store } = open(t)
  const [id] = enqueue(store, [job('a')])
  claim(store, WORKER_A, T0)
  assert.deepEqual(store.call('releaseJob', { id, owner: WORKER_A, checkpoint: { at: 9 }, now: T0 + SECOND }), { ok: true })
  assert.deepEqual(store.call('releaseJob', { id, owner: WORKER_A, now: T0 + SECOND }), { ok: false })
  const [again] = claim(store, WORKER_B, T0 + SECOND).jobs
  assert.deepEqual([again.attempts, again.checkpoint], [1, { at: 9 }])
})

test('finished jobs are pruned after a while and the queue refuses nonsense', t => {
  const { store } = open(t)
  const [id] = enqueue(store, [job('a'), job('b')])
  const [{ id: leased }] = claim(store, WORKER_A, T0, { limit: 1 }).jobs
  store.call('completeJob', { id: leased, owner: WORKER_A, result: {}, now: T0 })
  assert.deepEqual(store.call('pruneJobs', { before: T0 + 1 }), { pruned: 1 })
  assert.deepEqual(store.call('jobCounts').counts, { hash: { queued: 1 } })
  assert.ok(id)
  for (const request of [{ jobs: [{ class: HASH, subject: 'x' }], now: T0 }, { jobs: [{ class: '', subject: 'x', payload: {} }], now: T0 }, { jobs: 'all', now: T0 }, { jobs: [], now: -1 }]) {
    assert.throws(() => store.call('enqueueJobs', request), /invalid-request/)
  }
  assert.throws(() => claim(store, WORKER_A, T0, { leaseMs: 0 }), /invalid-request/)
})

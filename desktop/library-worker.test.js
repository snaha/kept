import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { CatalogStore, STORE_METHODS } from './catalog-store.js'
import { backoffMs } from './job-queue.js'
import { LEASE_MS, LibraryWorker } from './library-worker.js'
import { nodeFork } from './library-process.js'
import { createLibraryService } from './library-service.js'
import { PLAYING_DUTY, ResourcePolicy, TRACK_START_HOLD_MS } from './resource-policy.js'

const T0 = 5000000
const SECOND = 1000
const IDLE_CONCURRENCY = 2
const CLAIM_TIMEOUT_MS = 5000
const FIXTURE = new URL('./tests/job-fixture.js', import.meta.url).href
const CLASS = { name: 'fixture', process: 'library', module: FIXTURE, maxAttempts: 3 }
const playing = (isPlaying, waiting = false) => ({ kind: 'state', playing: isPlaying, waiting })

const openStore = (t, file) => {
  const directory = file ? undefined : mkdtempSync(path.join(os.tmpdir(), 'kept-worker-'))
  const target = file ?? path.join(directory, 'library.sqlite')
  const raw = new CatalogStore(target)
  t.after(() => { try { raw.close() } catch { /* closed by the test */ } if (directory) rmSync(directory, { recursive: true, force: true }) })
  // The catalog worker's interface: every call answers asynchronously.
  const store = Object.fromEntries(STORE_METHODS.map(method => [method, async request => raw.call(method, request)]))
  return { raw, store, file: target }
}
const until = async (check, what, timeout = 5000) => {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${what}`)
    await sleep(5)
  }
}

// A worker on a real store with a clock and timers the test moves by hand, and an executor it controls.
const manual = (t, { file, commit } = {}) => {
  const { raw, store, file: location } = openStore(t, file)
  let now = T0
  const timers = new Set()
  const runs = new Map(), aborted = [], gates = [], errors = []
  const executor = {
    setGate: snapshot => gates.push(snapshot.mode),
    run: (job, options) => new Promise((resolve, reject) => runs.set(job.id, { job, options, resolve, reject })),
    abort: id => aborted.push(id),
    close: async () => {},
  }
  const policy = new ResourcePolicy({ now: () => now, idleConcurrency: IDLE_CONCURRENCY })
  const worker = new LibraryWorker({
    store, classes: [{ ...CLASS, commit }], executorFor: () => executor, policy, now: () => now, owner: 'worker:test', onError: error => errors.push(error.message),
    setTimer: (fn, ms) => { const timer = { fn, at: now + ms }; timers.add(timer); return timer }, clearTimer: timer => timers.delete(timer),
  })
  t.after(() => worker.stop())
  const advance = async ms => {
    now += ms
    for (const timer of [...timers].filter(item => item.at <= now)) { timers.delete(timer); timer.fn() }
    await sleep(20)
  }
  return { raw, store, file: location, worker, policy, runs, aborted, gates, errors, advance, clock: () => now, timers }
}
const jobs = count => Array.from({ length: count }, (_, index) => ({ class: 'fixture', subject: `s${index}`, payload: { n: index } }))
const running = h => [...h.runs.values()].filter(run => !run.done).map(run => run.job.subject)
const finish = (h, subject, result = {}) => { const run = [...h.runs.values()].find(item => item.job.subject === subject); run.done = true; run.resolve(result) }

test('the policy decides how many jobs run: full when idle, one while playing, none while a track starts', async t => {
  const h = manual(t)
  await h.worker.start()
  await h.worker.enqueue(jobs(5))
  await until(() => running(h).length === IDLE_CONCURRENCY, 'two jobs run when idle')
  finish(h, 's0')
  await until(() => running(h).length === IDLE_CONCURRENCY && h.runs.size === 3, 'a finished job is replaced')

  h.policy.report(playing(true))
  h.worker.wake()
  await sleep(30)
  assert.equal(h.gates.at(-1), 'hold', 'the worker process is told to wait as soon as a track starts')
  finish(h, 's1')
  await sleep(30)
  assert.equal(h.runs.size, 3, 'no job starts during the hold')
  await h.advance(TRACK_START_HOLD_MS)
  await until(() => h.gates.at(-1) === 'playing', 'the process is told it may work, at a low duty')
  assert.equal(h.runs.size, 3, 'one job is running, which is all playing allows')
  finish(h, 's2')
  await until(() => h.runs.size === 4, 'the next job starts when that one ends')
  assert.deepEqual(running(h), ['s3'])
  h.policy.report(playing(false))
  h.worker.wake()
  await sleep(30)
  assert.equal(h.gates.at(-1), 'idle')
})

test('jobs claimed while idle are released when playing shrinks the allowance', async t => {
  const h = manual(t)
  await h.worker.start()
  await h.worker.enqueue(jobs(3))
  await until(() => running(h).length === IDLE_CONCURRENCY, 'two jobs run when idle')
  h.policy.report(playing(true))
  await h.advance(TRACK_START_HOLD_MS)
  await until(() => h.aborted.length === 1, 'the excess job is stopped')
  assert.equal(h.aborted[0], [...h.runs.values()][1].job.id, 'the newest one goes back')
  const { counts } = await h.store.jobCounts()
  assert.equal(counts.fixture.leased, 1, 'one running, the other queued again without a lost attempt')
  assert.equal(counts.fixture.queued, 2)
})

test('jobs claimed while a class is being paused go back without running or spending an attempt', { timeout: CLAIM_TIMEOUT_MS }, async t => {
  const h = manual(t)
  const claimed = Promise.withResolvers(), release = Promise.withResolvers()
  const claimJobs = h.store.claimJobs
  t.mock.method(h.store, 'claimJobs', async request => {
    const answer = await claimJobs(request)
    if (answer.jobs.length) {
      claimed.resolve()
      await release.promise
    }
    return answer
  })
  await h.worker.start()
  const [id] = await h.worker.enqueue(jobs(1))
  await claimed.promise
  try { await h.worker.setClassPaused(CLASS.name, true) }
  finally { release.resolve() }
  const job = async () => (await h.store.getJobs({ ids: [id] })).jobs[0]
  await until(async () => (await job()).state === 'queued' || h.runs.size > 0, 'the claim is handled')
  assert.equal(h.runs.size, 0)
  assert.deepEqual([(await job()).state, (await job()).attempts], ['queued', 0])
  await h.worker.setClassPaused(CLASS.name, false)
  await until(() => h.runs.has(id), 'the job runs after resuming')
  assert.equal(h.runs.get(id).job.attempts, 1)
})

test('waiting on a job leaves no listener on the signal once it ends', async t => {
  const h = manual(t)
  await h.worker.start()
  const controller = new AbortController()
  let listeners = 0
  const { signal } = controller
  const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal)
  signal.addEventListener = (...args) => { listeners++; add(...args) }
  signal.removeEventListener = (...args) => { listeners--; remove(...args) }
  const [id] = await h.worker.enqueue(jobs(1))
  const waited = h.worker.waitFor(id, signal)
  await until(() => h.runs.has(id), 'the job runs')
  finish(h, 's0', { done: true })
  await waited
  assert.equal(listeners, 0)
})

test('a failed job is retried after its backoff and only the last failure reaches the waiter', async t => {
  const h = manual(t)
  await h.worker.start()
  const [id] = await h.worker.enqueue(jobs(1))
  const outcome = h.worker.waitFor(id).then(value => ({ value }), error => ({ error: error.message }))
  for (let attempt = 1; attempt <= 3; attempt++) {
    await until(() => h.runs.get(id)?.job.attempts === attempt, `attempt ${attempt}`)
    h.runs.get(id).reject(new Error(`broke ${attempt}`))
    if (attempt < 3) {
      await sleep(30)
      await h.advance(backoffMs(attempt) - 1)
      assert.equal(h.runs.get(id).job.attempts, attempt, 'not before the backoff is over')
      await h.advance(1)
    }
  }
  assert.deepEqual(await outcome, { error: 'broke 3' })
  assert.deepEqual(h.errors.length, 3)
  assert.equal((await h.store.getJobs({ ids: [id] })).jobs[0].state, 'failed')
})

test('a result is committed before the job is done, and the waiter gets it', async t => {
  const committed = []
  const h = manual(t, { commit: async (job, result) => { committed.push([job.subject, result, (await h.store.getJobs({ ids: [job.id] })).jobs[0].state]) } })
  await h.worker.start()
  const [id] = await h.worker.enqueue(jobs(1))
  const waited = h.worker.waitFor(id)
  await until(() => h.runs.size === 1, 'job runs')
  finish(h, 's0', { contentHash: 'x' })
  assert.deepEqual(await waited, { contentHash: 'x' })
  assert.deepEqual(committed, [['s0', { contentHash: 'x' }, 'leased']])
  assert.deepEqual(await h.worker.waitFor(id), { contentHash: 'x' }, 'asking after the fact still answers')
  await assert.rejects(h.worker.enqueue([{ class: 'nope', subject: 'x', payload: {} }]), /Unknown job class/)
})

test('checkpoints are kept, and after a crash a new worker resumes from the last one', async t => {
  const first = manual(t)
  await first.worker.start()
  const [id] = await first.worker.enqueue(jobs(1))
  await until(() => first.runs.size === 1, 'job runs')
  first.runs.get(id).options.onCheckpoint({ step: 7 })
  first.runs.get(id).options.onCheckpoint({ step: 12 })
  await until(async () => (await first.store.getJobs({ ids: [id] })).jobs[0].checkpoint?.step === 12, 'checkpoint stored')
  // The crash: the process is gone without stopping anything. Its timers die with it.
  first.worker.stopped = true
  for (const entry of first.worker.running.values()) clearInterval(entry.lease)
  first.raw.close()

  const second = manual(t, { file: first.file })
  await second.worker.start()
  await until(() => second.runs.size === 1, `the job is claimed again at start ${second.errors}`)
  const resumed = second.runs.get(id).job
  assert.deepEqual([resumed.checkpoint, resumed.attempts], [{ step: 12 }, 2])
})

test('a worker that lost its lease stops the job and its result is dropped', async t => {
  const h = manual(t)
  await h.worker.start()
  const [id] = await h.worker.enqueue(jobs(1))
  await until(() => h.runs.size === 1, 'job runs')
  // The lease ran out and another worker took the job over.
  const takeover = await h.store.claimJobs({ owner: 'worker:other', classes: ['fixture'], limit: 1, leaseMs: LEASE_MS, now: h.clock() + 2 * LEASE_MS })
  assert.equal(takeover.jobs[0].id, id)
  await h.worker.renew(h.worker.running.get(id))
  assert.deepEqual(h.aborted, [id])
  h.runs.get(id).resolve({ stale: true })
  await sleep(30)
  const [job] = (await h.store.getJobs({ ids: [id] })).jobs
  assert.deepEqual([job.state, job.leaseOwner, job.result], ['leased', 'worker:other', undefined])
})

test('stopping hands running jobs back to the queue without costing an attempt', async t => {
  const h = manual(t)
  await h.worker.start()
  const ids = await h.worker.enqueue(jobs(3))
  await until(() => h.runs.size === IDLE_CONCURRENCY, 'jobs run')
  const waited = h.worker.waitFor(ids[0]).catch(error => error.message)
  await h.worker.stop()
  assert.equal(await waited, 'Stopped')
  const states = (await h.store.getJobs({ ids })).jobs.map(job => [job.state, job.attempts])
  assert.deepEqual(states, [['queued', 0], ['queued', 0], ['queued', 0]])
})

test('a paused class keeps its queue, hands back running jobs without an attempt and resumes where it stopped', async t => {
  const h = manual(t)
  await h.worker.start()
  const ids = await h.worker.enqueue(jobs(3))
  await until(() => running(h).length === IDLE_CONCURRENCY, 'two jobs run')
  await h.worker.setClassPaused('fixture', true)
  assert.equal(h.aborted.length, IDLE_CONCURRENCY, 'the running jobs are stopped')
  const states = (await h.store.getJobs({ ids })).jobs.map(job => [job.state, job.attempts])
  assert.deepEqual(states, [['queued', 0], ['queued', 0], ['queued', 0]], 'all three wait, no attempt is spent')
  assert.deepEqual((await h.worker.status()).paused, ['fixture'])
  const started = h.runs.size
  await h.advance(LEASE_MS)
  assert.equal(h.runs.size, started, 'nothing is claimed while paused, whatever the clock does')
  assert.equal(h.timers.size, 0, 'a paused queue does not keep the worker polling')

  await h.worker.setClassPaused('fixture', false)
  await until(() => running(h).length === IDLE_CONCURRENCY, 'resuming claims the queue again')
  assert.deepEqual((await h.worker.status()).paused, [])
  await assert.rejects(h.worker.setClassPaused('nope', true), /Unknown job class/)
})

// The same, across a real process.
const real = (t, extra = {}) => {
  const { raw, store } = openStore(t)
  let offset = 0
  const policy = new ResourcePolicy({ idleConcurrency: IDLE_CONCURRENCY })
  const service = createLibraryService({ store, fork: nodeFork, classes: [CLASS], policy, now: () => Date.now() + offset, onError: () => {}, ...extra })
  t.after(() => service.stop())
  return { raw, store, service, policy, skip: ms => { offset += ms } }
}

test('a job runs in a separate process of lower priority and its result comes back', async t => {
  const { service } = real(t)
  await service.start()
  const [id] = await service.worker.enqueue([{ class: 'fixture', subject: 'echo', payload: { kind: 'echo', value: 'hello' } }])
  const result = await service.worker.waitFor(id)
  assert.equal(result.value, 'hello')
  assert.notEqual(result.pid, process.pid)
  assert.ok(result.priority > 0, `nice value ${result.priority}`)
})

test('a worker process with nothing to do is stopped, and the next job starts a new one', async t => {
  const { store } = openStore(t)
  const executors = []
  const idleMs = 150
  const service = createLibraryService({ store, classes: [CLASS], onError: () => {}, idleMs, fork: (file, name) => {
    const child = nodeFork(file, name)
    executors.push(child)
    return child
  } })
  t.after(() => service.stop())
  await service.start()
  const echo = async subject => service.worker.waitFor((await service.worker.enqueue([{ class: 'fixture', subject, payload: { kind: 'echo', value: subject } }]))[0])
  const first = await echo('one')
  const second = await echo('two')
  assert.equal(second.pid, first.pid, 'a busy process is kept')
  await sleep(idleMs * 3)
  assert.throws(() => process.kill(first.pid, 0), 'the idle process is gone')
  const third = await echo('three')
  assert.notEqual(third.pid, first.pid)
  assert.equal(executors.length, 2)
})

test('a handler that throws fails the attempt, and a process that dies is replaced for the retry', async t => {
  const { service, store, skip } = real(t)
  await service.start()
  const [bad] = await service.worker.enqueue([{ class: 'fixture', subject: 'bad', payload: { kind: 'throw' }, maxAttempts: 1 }])
  await assert.rejects(service.worker.waitFor(bad), /handler failed/)
  const [died] = await service.worker.enqueue([{ class: 'fixture', subject: 'die', payload: { kind: 'die' } }])
  const outcome = service.worker.waitFor(died)
  outcome.catch(() => {})
  await until(async () => {
    const { jobs: [job] } = await store.getJobs({ ids: [died] })
    return job.state === 'queued' && job.attempts === 1
  }, 'the death is noticed and the job queued again')
  skip(backoffMs(1))
  service.worker.wake()
  assert.deepEqual(await outcome, { attempts: 2 })
})

test('a job interrupted by a process crash resumes from its checkpoint on the retry', async t => {
  const { service, store, skip } = real(t)
  await service.start()
  const [id] = await service.worker.enqueue([{ class: 'fixture', subject: 'steps', payload: { kind: 'steps', to: 10, crashAt: 6 } }])
  const outcome = service.worker.waitFor(id)
  outcome.catch(() => {})
  await until(async () => {
    const { jobs: [job] } = await store.getJobs({ ids: [id] })
    return job.state === 'queued' && job.attempts === 1
  }, 'the crash is noticed')
  assert.equal((await store.getJobs({ ids: [id] })).jobs[0].checkpoint.step, 6)
  skip(backoffMs(1))
  service.worker.wake()
  assert.deepEqual(await outcome, { startedAt: 6, steps: 10 })
})

test('work in the process waits while the window reports a stall and goes on afterwards', async t => {
  const { service, store } = real(t)
  await service.start()
  service.reportPlayback(playing(true, true))
  const [id] = await service.worker.enqueue([{ class: 'fixture', subject: 'steps', payload: { kind: 'steps', to: 30 } }])
  await sleep(300)
  assert.equal((await store.getJobs({ ids: [id] })).jobs[0].state, 'queued', 'nothing is claimed while the audio waits')
  service.reportPlayback(playing(true, false))
  service.reportPlayback(playing(false))
  const outcome = service.worker.waitFor(id)
  await until(async () => (await store.getJobs({ ids: [id] })).jobs[0].checkpoint?.step > 3, 'the job runs once idle', 5000)
  service.reportPlayback(playing(true, true))
  await sleep(100)
  const during = (await store.getJobs({ ids: [id] })).jobs[0].checkpoint?.step
  await sleep(300)
  assert.equal((await store.getJobs({ ids: [id] })).jobs[0].checkpoint?.step, during, 'a job that is running stops at its next rest')
  service.reportPlayback(playing(false))
  assert.equal((await outcome).steps, 30)
  assert.ok(PLAYING_DUTY < 1)
})

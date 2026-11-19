import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_REST_MS, PLAYING_CONCURRENCY, PLAYING_DUTY, PlaybackGate, RESUME_HOLD_MS, ResourcePolicy, STALL_HOLD_MS, TRACK_START_HOLD_MS } from './resource-policy.js'

const IDLE_CONCURRENCY = 3
const clock = () => { const clock = { at: 0, now: () => clock.at, advance: ms => { clock.at += ms } }; return clock }
const state = (playing, waiting = false) => ({ kind: 'state', playing, waiting })
const mode = policy => policy.snapshot().mode

test('paused and idle: full concurrency and no pauses', () => {
  const time = clock(), policy = new ResourcePolicy({ now: time.now, idleConcurrency: IDLE_CONCURRENCY })
  assert.deepEqual(policy.snapshot(), { mode: 'idle', concurrency: IDLE_CONCURRENCY, dutyCycle: 1, holdMs: 0 })
  policy.report({ kind: 'track-start' })
  assert.equal(mode(policy), 'idle', 'loading a track while paused is not playback')
})

test('playing: one job at low duty, and nothing at all while a track starts', () => {
  const time = clock(), policy = new ResourcePolicy({ now: time.now, idleConcurrency: IDLE_CONCURRENCY })
  policy.report({ kind: 'track-start' })
  policy.report(state(true))
  assert.deepEqual(policy.snapshot(), { mode: 'hold', concurrency: 0, dutyCycle: 0, holdMs: TRACK_START_HOLD_MS })
  time.advance(TRACK_START_HOLD_MS - 1)
  assert.equal(mode(policy), 'hold')
  time.advance(1)
  assert.deepEqual(policy.snapshot(), { mode: 'playing', concurrency: PLAYING_CONCURRENCY, dutyCycle: PLAYING_DUTY, holdMs: 0 })
  policy.report(state(false))
  assert.equal(policy.snapshot().concurrency, IDLE_CONCURRENCY, 'pausing gives the full concurrency back')
})

test('a stall pauses everything until the audio recovers and has settled', () => {
  const time = clock(), policy = new ResourcePolicy({ now: time.now })
  policy.report(state(true))
  time.advance(TRACK_START_HOLD_MS)
  assert.equal(mode(policy), 'playing')
  policy.report({ kind: 'stall' })
  policy.report(state(true, true))
  time.advance(STALL_HOLD_MS + 1)
  assert.equal(mode(policy), 'hold', 'a stream that is still waiting stays held, however long it takes')
  policy.report(state(true, false))
  assert.deepEqual([mode(policy), policy.snapshot().holdMs], ['hold', RESUME_HOLD_MS])
  time.advance(RESUME_HOLD_MS)
  assert.equal(mode(policy), 'playing')
  policy.report({ kind: 'stall' })
  assert.equal(policy.snapshot().holdMs, STALL_HOLD_MS)
})

test('a window that goes away stops being a reason to wait, and a disabled policy never holds', () => {
  const time = clock(), policy = new ResourcePolicy({ now: time.now, idleConcurrency: IDLE_CONCURRENCY })
  policy.report(state(true, true))
  assert.equal(mode(policy), 'hold')
  policy.report(state(false, false))
  assert.equal(mode(policy), 'idle')
  policy.report(state(true))
  policy.enabled = false
  assert.deepEqual(policy.snapshot(), { mode: 'idle', concurrency: IDLE_CONCURRENCY, dutyCycle: 1, holdMs: 0 })
})

test('the gate holds work during a hold, spaces it while playing and lets it run when idle', async () => {
  const time = clock(), sleeps = []
  const gate = new PlaybackGate({ now: time.now, sleep: async ms => { sleeps.push(ms); time.advance(ms) } })
  time.advance(10)
  await gate.rest()
  assert.deepEqual(sleeps, [], 'idle: no rest')
  gate.apply({ mode: 'playing', concurrency: 1, dutyCycle: 0.25, holdMs: 0 })
  time.advance(10)
  await gate.rest()
  assert.deepEqual(sleeps, [30], 'a quarter duty: three rests per unit of work')
  time.advance(1000)
  await gate.rest()
  assert.equal(sleeps.at(-1), MAX_REST_MS)
  gate.apply({ mode: 'hold', concurrency: 0, dutyCycle: 0, holdMs: 100 })
  let resumed = false
  const waiting = gate.rest().then(() => { resumed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(resumed, false, 'work waits for the hold to end')
  gate.apply({ mode: 'playing', concurrency: 1, dutyCycle: 0.25, holdMs: 0 })
  await waiting
  assert.equal(resumed, true)
  const controller = new AbortController()
  gate.apply({ mode: 'hold', concurrency: 0, dutyCycle: 0, holdMs: 100 })
  const cancelled = gate.rest(controller.signal)
  controller.abort()
  await cancelled
})

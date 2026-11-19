import os from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

// A job handler for the library worker tests, loaded by the worker process as a job class module.
const STEP_MS = 4
export default async ctx => {
  const { kind } = ctx.payload
  if (kind === 'echo') return { value: ctx.payload.value, pid: process.pid, priority: os.getPriority(0) }
  if (kind === 'throw') throw new Error('handler failed')
  if (kind === 'die') {
    // The process vanishes on the first attempt, as in a crash.
    if (ctx.attempts === 1) process.exit(1)
    return { attempts: ctx.attempts }
  }
  if (kind === 'steps') {
    // Counts to payload.to, saving each step. With crashAt, the first attempt dies there.
    const startedAt = ctx.checkpoint?.step ?? 0
    for (let step = startedAt; step < ctx.payload.to; step++) {
      await ctx.rest()
      await sleep(STEP_MS)
      ctx.save({ step: step + 1 })
      if (ctx.attempts === 1 && ctx.payload.crashAt === step + 1) process.exit(1)
    }
    return { startedAt, steps: ctx.payload.to }
  }
  throw new Error(`Unknown fixture job ${kind}`)
}

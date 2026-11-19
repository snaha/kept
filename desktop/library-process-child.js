import os from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { PlaybackGate } from './resource-policy.js'

// The program of a library worker process (utilityProcess in Electron, a forked Node process in
// tests). It runs one handler per job, loaded on first use from the module the job class names:
//   export default async ctx => result
//   ctx.payload      the job's payload
//   ctx.checkpoint   what the last attempt saved, or undefined
//   ctx.save(data)   keeps data as the checkpoint, so a restart resumes from here
//   ctx.rest()       call between small slices of work: it waits during a hold and spaces the work while playing
//   ctx.signal       aborted when the job is cancelled or its lease is lost
// A handler that throws fails the attempt; the library worker decides about retrying.

const LOW_PRIORITY = 10
const parent = process.parentPort
  ? { on: callback => process.parentPort.on('message', event => callback(event.data)), post: message => process.parentPort.postMessage(message) }
  : { on: callback => process.on('message', callback), post: message => process.send(message) }

// Background work yields to playback, which runs in the window's own processes.
try { os.setPriority(0, LOW_PRIORITY) } catch { /* the priority stays as it was */ }

const gate = new PlaybackGate({ sleep: ms => sleep(ms) })
const running = new Map()
const handlers = new Map()

// Deliberate lazy loading: a handler's heavy dependencies load only in the process that runs its class.
const handlerOf = async module => {
  let handler = handlers.get(module)
  if (!handler) handlers.set(module, handler = (await import(module)).default)
  return handler
}

async function run({ id, module, job }) {
  const controller = new AbortController()
  running.set(id, controller)
  try {
    const handler = await handlerOf(module)
    const result = await handler({
      payload: job.payload, checkpoint: job.checkpoint, attempts: job.attempts, signal: controller.signal,
      save: data => { if (!controller.signal.aborted) parent.post({ type: 'checkpoint', id, data }) },
      rest: () => gate.rest(controller.signal),
    })
    if (!controller.signal.aborted) parent.post({ type: 'done', id, result: result ?? {} })
  } catch (error) {
    if (!controller.signal.aborted) parent.post({ type: 'error', id, message: error?.message ?? String(error) })
  } finally {
    if (running.get(id) === controller) running.delete(id)
  }
}

parent.on(message => {
  if (message.type === 'run') void run(message)
  else if (message.type === 'abort') running.get(message.id)?.abort()
  else if (message.type === 'gate') gate.apply(message.snapshot)
})

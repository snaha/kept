import { fork as forkNode } from 'node:child_process'

// Runs job handlers in a separate OS process, so a crash, a leak or a heavy library in a handler
// (WASM inference) cannot touch the window or the catalog, and so the process can be given a lower
// priority. The process starts with the first job and is replaced if it dies.
//
// fork(file, name) -> { post(message), onMessage(callback), onExit(callback), kill() }
// In Electron that is utilityProcess (electronFork in main.js); in Node tests nodeFork below.

export const CHILD_FILE = new URL('./library-process-child.js', import.meta.url)

export const nodeFork = (file, name) => {
  const child = forkNode(file, [], { serialization: 'json', env: { ...process.env, KEPT_JOB_PROCESS: name } })
  return { post: message => child.send(message), onMessage: callback => child.on('message', callback), onExit: callback => child.on('exit', callback), kill: () => child.kill() }
}

export class ProcessExecutor {
  constructor({ fork, name, file = CHILD_FILE }) {
    this.fork = fork
    this.name = name
    this.file = file
    this.pending = new Map()
    this.gate = undefined
    this.closed = false
  }
  spawn() {
    if (this.child) return this.child
    const child = this.fork(this.file, this.name)
    this.child = child
    child.onMessage(message => {
      const request = this.pending.get(message.id)
      if (!request) return
      if (message.type === 'checkpoint') request.onCheckpoint?.(message.data)
      else {
        this.pending.delete(message.id)
        if (message.type === 'done') request.resolve(message.result)
        else request.reject(new Error(message.message))
      }
    })
    child.onExit(code => {
      if (this.child !== child) return
      this.child = undefined
      const error = new Error(`The ${this.name} worker process stopped (${code})`)
      for (const request of this.pending.values()) request.reject(error)
      this.pending.clear()
    })
    if (this.gate) child.post({ type: 'gate', snapshot: this.gate })
    return child
  }
  run(job, { module, onCheckpoint }) {
    if (this.closed) return Promise.reject(new Error('The worker process is closed'))
    return new Promise((resolve, reject) => {
      this.pending.set(job.id, { resolve, reject, onCheckpoint })
      try { this.spawn().post({ type: 'run', id: job.id, module, job: { class: job.class, subject: job.subject, payload: job.payload, checkpoint: job.checkpoint, attempts: job.attempts } }) }
      catch (error) { this.pending.delete(job.id); reject(error) }
    })
  }
  abort(id) {
    this.pending.get(id)?.reject(new Error('Aborted'))
    this.pending.delete(id)
    this.child?.post({ type: 'abort', id })
  }
  setGate(snapshot) {
    this.gate = snapshot
    this.child?.post({ type: 'gate', snapshot })
  }
  close() {
    this.closed = true
    const child = this.child
    this.child = undefined
    for (const request of this.pending.values()) request.reject(new Error('The worker process is closed'))
    this.pending.clear()
    child?.kill()
    return Promise.resolve()
  }
}

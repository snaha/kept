import { Worker } from 'node:worker_threads'

// One owner for a worker thread: calls are answered in order, a crash rejects every
// pending call, and close() ends the thread. The worker answers { id, value } or { id, error }.
export class WorkerClient {
  constructor(url, workerData, label) {
    this.label = label
    this.pending = new Map()
    this.sequence = 0
    this.worker = new Worker(url, { workerData })
    this.worker.on('message', ({ id, value, error }) => {
      const request = this.pending.get(id)
      this.pending.delete(id)
      if (error === undefined) request?.resolve(value)
      else request?.reject(new Error(error))
    })
    const fail = error => {
      this.failure = error
      for (const request of this.pending.values()) request.reject(error)
      this.pending.clear()
    }
    this.worker.on('error', fail)
    this.worker.on('exit', code => fail(new Error(`${label} worker stopped (${code})`)))
  }
  call(method, args) {
    if (this.closing) return Promise.reject(new Error(`${this.label} is closing`))
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      this.pending.set(id, { resolve, reject })
      try { this.worker.postMessage({ id, method, args }) }
      catch (error) {
        this.pending.delete(id)
        reject(error)
      }
    })
  }
  close() {
    if (!this.closing) {
      const asked = this.failure ? Promise.resolve() : this.call('close').catch(() => {})
      this.closing = asked.finally(() => this.worker.terminate())
    }
    return this.closing
  }
}

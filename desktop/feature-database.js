import { FEATURE_METHODS } from './feature-store.js'
import { WorkerClient } from './worker-client.js'

// features.sqlite as the main process sees it: owned by one worker thread, like library.sqlite.
export class FeatureDatabase {
  constructor(file) {
    this.client = new WorkerClient(new URL('./feature-store-worker.js', import.meta.url), { file }, 'Feature database')
    this.store = Object.freeze(Object.fromEntries(FEATURE_METHODS.map(method => [method, request => this.client.call(method, request)])))
  }
  close() { return this.client.close() }
}

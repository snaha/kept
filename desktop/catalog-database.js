import { CATALOG_METHODS, STORE_METHODS } from './catalog-store.js'
import { WorkerClient } from './worker-client.js'

// The catalog as the main process sees it: library.sqlite is owned by one worker thread.
// service is the CatalogService of shared/catalog.ts. store adds the scanner's hash memory.
export class CatalogDatabase {
  constructor(file) {
    this.client = new WorkerClient(new URL('./catalog-store-worker.js', import.meta.url), { file }, 'Catalog database')
    const bind = methods => Object.freeze(Object.fromEntries(methods.map(method => [method, request => this.client.call(method, request)])))
    this.service = bind(CATALOG_METHODS)
    this.store = bind(STORE_METHODS)
  }
  close() { return this.client.close() }
}

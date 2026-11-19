import { parentPort, workerData } from 'node:worker_threads'
import { CatalogStore } from './catalog-store.js'

const store = new CatalogStore(workerData.file)
parentPort.on('message', ({ id, method, args }) => {
  try {
    if (method === 'close') {
      store.close()
      parentPort.postMessage({ id })
      parentPort.close()
      return
    }
    parentPort.postMessage({ id, value: store.call(method, args) })
  } catch (error) { parentPort.postMessage({ id, error: error.message }) }
})

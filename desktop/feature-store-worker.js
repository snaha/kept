import { parentPort, workerData } from 'node:worker_threads'
import { FeatureStore } from './feature-store.js'

const store = new FeatureStore(workerData.file)
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

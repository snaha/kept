import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { FEATURES_FILE, readFeatures } from './features.js'
import { featureArgument, featuresFromArgv } from './feature-argument.js'

async function withFile(contents, check) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kept-features-'))
  try {
    if (contents !== undefined) await writeFile(path.join(directory, FEATURES_FILE), contents)
    await check(directory)
  } finally { await rm(directory, { recursive: true, force: true }) }
}

test('trial features stay off unless the profile turns them on with true', async () => {
  await withFile(undefined, directory => assert.deepEqual(readFeatures(directory), { spotify: false }))
  await withFile('{ "spotify": true }', directory => assert.deepEqual(readFeatures(directory), { spotify: true }))
  for (const contents of ['{ "spotify": "yes" }', 'null', '[]', '{ not json', '{ "spotify": 1, "unknown": true }']) {
    await withFile(contents, directory => assert.deepEqual(readFeatures(directory), { spotify: false }, contents))
  }
})

test('a window learns exactly the features that are on', () => {
  const argv = ['electron', '--type=renderer', featureArgument({ spotify: true, other: false })]
  assert.deepEqual([...featuresFromArgv(argv)], ['spotify'])
  assert.deepEqual([...featuresFromArgv(['electron', featureArgument({ spotify: false })])], [])
  assert.deepEqual([...featuresFromArgv(['electron'])], [])
})

// The preload as it ships: bundled, with Electron replaced by a recorder of what it exposes to the window.
async function exposedBy(argv) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('./preload.js', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], write: false,
  })
  const exposed = []
  const electron = { contextBridge: { exposeInMainWorld: name => exposed.push(name) }, ipcRenderer: { invoke: async () => ({}), on() {}, removeListener() {}, send() {} } }
  vm.runInNewContext(outputFiles[0].text, { require: () => electron, module: { exports: {} }, exports: {}, process: { argv }, console })
  return exposed
}

test('the preload gives the window a Spotify bridge only when the main process says Spotify is on', async () => {
  const off = await exposedBy(['electron', featureArgument({ spotify: false })])
  assert.equal(off.includes('musicSpotify'), false)
  assert.equal(off.includes('desktop'), true, 'the rest of the bridge is still there')
  assert.equal((await exposedBy(['electron'])).includes('musicSpotify'), false)
  assert.equal((await exposedBy(['electron', featureArgument({ spotify: true })])).includes('musicSpotify'), true)
})

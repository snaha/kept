import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build, transform } from 'esbuild'
import { compileModule } from '../../frontend/tests/runes-compiler.mjs'

const ROOT = path.resolve(import.meta.dirname, '../..')
const READY_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 5_000
const TEST_TIMEOUT_MS = 60_000
const POLL_MS = 100
const DIAGNOSTIC_LENGTH = 2_000
const BAD_GATEWAY = 502
const TEMPORARY_REDIRECT = 307

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})
const close = server => new Promise(resolve => {
  server.closeAllConnections()
  server.close(resolve)
})

test('real Navidrome: HTTP sharing stays restricted, retains credentials and refuses redirects', { timeout: TEST_TIMEOUT_MS }, async t => {
  const cleanup = []
  t.after(async () => {
    const failures = []
    for (const dispose of cleanup.reverse()) {
      try { await dispose() } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Integration cleanup failed')
  })
  const directory = await mkdtemp(path.join(os.tmpdir(), 'music-sharing-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const reserve = http.createServer()
  const port = await listen(reserve)
  await close(reserve)
  const backend = `http://127.0.0.1:${port}`
  const adminPassword = crypto.randomUUID()
  await mkdir(path.join(directory, 'music'))
  const child = spawn(path.join(ROOT, 'desktop/bin/navidrome'), [], {
    cwd: directory,
    env: {
      ...process.env, ND_ADDRESS: '127.0.0.1', ND_PORT: String(port),
      ND_DATAFOLDER: directory, ND_CACHEFOLDER: path.join(directory, 'cache'),
      ND_MUSICFOLDER: path.join(directory, 'music'), ND_DEVAUTOCREATEADMINPASSWORD: adminPassword,
      ND_ENABLEINSIGHTSCOLLECTOR: 'false', ND_SCANNER_SCHEDULE: '0', ND_LOGLEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let diagnostics = ''
  let spawnError
  let exited = false
  child.on('error', error => { spawnError = error })
  const closed = new Promise(resolve => child.once('close', () => { exited = true; resolve() }))
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    diagnostics = (diagnostics + chunk).slice(-DIAGNOSTIC_LENGTH)
  })
  cleanup.push(async () => {
    if (!exited) child.kill('SIGTERM')
    const timer = setTimeout(() => { if (!exited) child.kill('SIGKILL') }, REQUEST_TIMEOUT_MS)
    try { await closed } finally { clearTimeout(timer) }
  })
  let redirectAuth = false
  let redirectRest = false
  let sinkRequests = 0
  const sink = http.createServer((_req, res) => { sinkRequests++; res.end('unexpected credential destination') })
  cleanup.push(() => close(sink))
  const sinkUrl = `http://127.0.0.1:${await listen(sink)}`
  const proxy = http.createServer(async (req, res) => {
    if ((redirectAuth && req.url.endsWith('/auth/login')) || redirectRest) {
      res.writeHead(TEMPORARY_REDIRECT, { location: sinkUrl }).end()
      return
    }
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const headers = { ...req.headers }
      delete headers.host
      delete headers.connection
      const response = await fetch(backend + req.url.replace(/^\/music/, ''), {
        method: req.method, headers,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
        redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' })
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch { res.writeHead(BAD_GATEWAY).end() }
  })
  cleanup.push(() => close(proxy))
  const base = `http://127.0.0.1:${await listen(proxy)}/music`
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (true) {
    if (spawnError) throw spawnError
    if (exited || Date.now() > deadline) throw new Error(`Backend not ready: ${diagnostics}`)
    try {
      if ((await fetch(`${backend}/rest/ping`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })).ok) break
    } catch {}
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }

  const previous = Object.fromEntries(['window', 'location', 'localStorage', 'crypto'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  cleanup.push(() => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  globalThis.window = {}
  globalThis.location = { href: 'http://192.168.1.10/library/' }
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: crypto.getRandomValues.bind(crypto) } })
  const storage = new Map()
  globalThis.localStorage = {
    getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key),
  }
  const outfile = path.join(directory, 'sharing.mjs')
  await build({
    stdin: {
      contents: "export { login, session } from './src/lib/api.svelte.ts'; export { shareLink } from './src/lib/sharing.svelte.ts'",
      resolveDir: path.join(ROOT, 'frontend'), loader: 'ts',
    },
    define: { __LAN_IP__: JSON.stringify('127.0.0.1') },
    outfile, bundle: true, platform: 'node', format: 'esm', conditions: ['browser'],
    plugins: [{ name: 'runes', setup(builder) {
      builder.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path: filename }) => {
        const source = await transform(await readFile(filename, 'utf8'), { loader: 'ts' })
        return { contents: compileModule(source.code, { filename, generate: 'client' }).js.code, loader: 'js' }
      })
    } }],
  })
  const { login, session, shareLink } = await import(pathToFileURL(outfile).href)
  await login({ url: base, username: 'admin', password: adminPassword })
  assert.equal(session.admin, true)
  const first = new URLSearchParams(new URL(await shareLink()).hash.slice(1))
  assert.equal(first.get('s'), base)
  assert.equal(first.get('u'), 'share')
  const password = first.get('p')
  assert.ok(password)
  const auth = await session.api.navidromeSession()
  const headers = { 'content-type': 'application/json', 'x-nd-authorization': `Bearer ${auth.token}` }
  const native = async (suffix, method = 'GET', body) => {
    const response = await fetch(`${base}/api${suffix}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
      redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    assert.equal(response.ok, true, 'native request succeeded')
    return response.json()
  }
  let user = (await native('/user')).find(user => user.userName === 'share')
  assert.equal(user.isAdmin, false)
  const second = new URLSearchParams(new URL(await shareLink()).hash.slice(1))
  assert.equal(second.get('p'), password)
  await login({ url: base, username: 'share', password })
  assert.equal(session.admin, false, 'shared credentials log in with a restricted role')
  await login({ url: base, username: 'admin', password: adminPassword })
  await native(`/user/${user.id}`, 'PUT', { ...user, isAdmin: true })
  await assert.rejects(shareLink(), /is an administrator/)
  user = (await native('/user')).find(user => user.userName === 'share')
  assert.equal(user.isAdmin, true)
  await login({ url: base, username: 'share', password })
  assert.equal(session.admin, true, 'admin collision left the existing password and role intact')

  redirectAuth = true
  await assert.rejects(session.api.navidromeSession(), /fetch failed/)
  redirectAuth = false
  redirectRest = true
  await assert.rejects(login({ url: base, username: 'admin', password: adminPassword }), /fetch failed/)
  assert.equal(sinkRequests, 0, 'neither native authentication nor REST followed a credential-bearing redirect')
})

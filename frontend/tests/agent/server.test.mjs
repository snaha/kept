import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 2_000

for (const shutdown of ['signal', 'disconnect']) {
  test(`journey fixture serves the selected build on a free port and releases resources on ${shutdown}`, { timeout: TIMEOUT_MS }, async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'music-fixture-contract-'))
    await writeFile(path.join(directory, 'index.html'), '<html><head></head><body>candidate-build</body></html>')
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 'server.mjs')], {
      env: { ...process.env, MUSIC_AUDIT_PORT: '0', MUSIC_AUDIT_ROOT: directory },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    let diagnostics = ''
    child.stderr.on('data', chunk => { diagnostics += chunk })
    let exited = false
    const closed = new Promise(resolve => child.once('exit', code => { exited = true; resolve(code) }))
    t.after(async () => {
      if (!exited) child.kill('SIGKILL')
      await closed
      await rm(directory, { recursive: true, force: true })
    })
    const { url } = await new Promise((resolve, reject) => {
      child.once('message', resolve)
      child.once('error', reject)
      child.once('exit', () => reject(new Error(`Fixture exited before readiness: ${diagnostics}`)))
    })
    assert.match(url, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/)
    const html = await (await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })).text()
    assert.ok(html.includes('candidate-build'))
    assert.ok(html.includes('<head><script>'), 'the production HTML receives the isolated fixture bridge')
    const library = await (await fetch(`${url}/rest/getAlbumList2`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })).json()
    assert.ok(library['subsonic-response'].albumList2.album.length > 1)
    if (shutdown === 'signal') child.kill('SIGTERM')
    else child.disconnect()
    assert.equal(await closed, 0, diagnostics)
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }))
  })
}

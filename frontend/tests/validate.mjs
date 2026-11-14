import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, createWriteStream, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { chromium } from 'playwright'

const ROOT = path.resolve(import.meta.dirname, '../..')
const READY_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 5_000
const STAGE_TIMEOUT_MS = 15 * 60_000
const JSON_INDENT = 2
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const output = path.join(ROOT, '.audit-results', `validation-${runId}`)
await mkdir(output, { recursive: true })
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
const sourceHash = createHash('sha256')
for (const file of git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean).sort()) {
  const filename = path.join(ROOT, file)
  sourceHash.update(file).update('\0').update(existsSync(filename) ? readFileSync(filename) : '<deleted>')
}
const report = {
  commit: git('rev-parse', 'HEAD'),
  workingTree: git('status', '--short'),
  sourceSha256: sourceHash.digest('hex'),
  node: process.version,
  startedAt: new Date().toISOString(),
  status: 'running',
  stages: [],
  manual: {
    visualReview: 'pending: inspect journey screenshots against approved references',
    nativeApp: 'pending: fresh profile, folder chooser, restart, audible playback',
    phone: 'pending: QR on home Wi-Fi, audible playback, touch and background/resume',
    tailscale: 'pending: separate-network connection and playback',
    performance: 'pending: measured phone frame pacing while indexing and playing',
  },
}
const browser = process.env.MUSIC_TEST_BROWSER || chromium.executablePath()
const env = { ...process.env, MUSIC_TEST_BROWSER: browser, AGENT_BROWSER_EXECUTABLE_PATH: browser }
const children = new Set()
let interrupted = false
let journeyStarted = false
const journeySession = `music-${runId}`
const journeyCli = path.join(ROOT, 'frontend/node_modules/.bin/agent-browser')

function launch(command, args, name, extra = {}) {
  const log = createWriteStream(path.join(output, `${name}.log`))
  const child = spawn(command, args, {
    cwd: ROOT, env, detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'], ...extra,
  })
  children.add(child)
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  child.stdout.pipe(process.stdout, { end: false })
  child.stderr.pipe(process.stderr, { end: false })
  child.completion = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      children.delete(child)
      log.end()
      if (code === 0) resolve()
      else reject(new Error(`${name} exited ${signal || code}; see ${name}.log`))
    })
  })
  // The fixture can fail before readiness; its completion is consumed during cleanup.
  child.completion.catch(() => {})
  return child
}

function signal(child, value) {
  if (!children.has(child) || !child.pid) return
  try {
    if (process.platform === 'win32') child.kill(value)
    else process.kill(-child.pid, value)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

async function stop(child) {
  signal(child, 'SIGTERM')
  const timer = setTimeout(() => signal(child, 'SIGKILL'), STOP_TIMEOUT_MS)
  try { await child.completion.catch(() => {}) } finally { clearTimeout(timer) }
}

async function stage(name, action) {
  if (interrupted) throw new Error('Validation interrupted')
  const entry = { name, status: 'running', startedAt: new Date().toISOString() }
  report.stages.push(entry)
  console.log(`\n[validate] ${name}`)
  let timer
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} timed out`)), STAGE_TIMEOUT_MS) }),
    ])
    if (interrupted) throw new Error('Validation interrupted')
    entry.status = 'passed'
  } catch (error) {
    entry.status = 'failed'
    entry.error = error.message
    throw error
  } finally { clearTimeout(timer); entry.finishedAt = new Date().toISOString() }
}

const pnpm = (directory, script, name = script) => stage(name, () =>
  launch('pnpm', ['--dir', directory, script], name).completion)

for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => {
  interrupted = true
  for (const child of children) void stop(child)
})

try {
  await stage('preflight', () => {
    const database = new DatabaseSync(':memory:')
    try { database.exec('CREATE VIRTUAL TABLE probe USING fts5(content)') } catch {
      throw new Error(`Node ${process.version} lacks SQLite FTS5. Use a Node build with FTS5 (CI uses Node 22).`)
    } finally { database.close() }
    if (!existsSync(browser)) throw new Error('Chromium is missing. Run pnpm --dir frontend exec playwright install chromium')
    if (!existsSync(journeyCli)) {
      throw new Error('Run pnpm --dir frontend install --frozen-lockfile to install the pinned journey runner')
    }
    if (process.env.MUSIC_AUDIT_VIEWPORT) throw new Error('Full validation requires all four viewports; unset MUSIC_AUDIT_VIEWPORT')
  })
  await pnpm('frontend', 'check')
  await pnpm('frontend', 'test:unit', 'components')
  await pnpm('desktop', 'test', 'desktop-and-helpers')
  await pnpm('frontend', 'audit:test', 'fixture-contract')
  await pnpm('desktop', 'navidrome')
  await pnpm('desktop', 'test:integration', 'real-navidrome')
  await pnpm('desktop', 'build:preload', 'build-preload')
  await pnpm('desktop', 'build:frontend', 'build-frontend')
  await stage('application-journey', async () => {
    const fixture = launch(process.execPath, ['frontend/tests/agent/server.mjs'], 'fixture-server', {
      env: { ...env, MUSIC_AUDIT_PORT: '0', MUSIC_AUDIT_ROOT: path.join(ROOT, 'desktop/dist') },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    try {
      const url = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Fixture readiness timed out')), READY_TIMEOUT_MS)
        fixture.once('message', message => { clearTimeout(timer); resolve(message.url) })
        fixture.completion.then(() => { clearTimeout(timer); reject(new Error('Fixture exited before the journey')) }, error => { clearTimeout(timer); reject(error) })
      })
      journeyStarted = true
      await launch('pnpm', ['--dir', 'frontend', 'audit:regressions'], 'application-journey', {
        env: {
          ...env, MUSIC_AUDIT_URL: url,
          MUSIC_AUDIT_OUTPUT: path.join(output, 'journey'),
          MUSIC_AGENT_BROWSER: journeyCli,
          MUSIC_AUDIT_SESSION: journeySession,
        },
      }).completion
    } finally {
      await stop(fixture)
      await fixture.completion
    }
  })
  report.status = interrupted ? 'failed' : 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error.message
  console.error(error.message)
} finally {
  await Promise.all([...children].map(stop))
  // A terminated journey cannot execute its own finally block. Reclaim its isolated daemon too.
  if (journeyStarted && report.status !== 'passed') {
    try { execFileSync(journeyCli, ['--session', journeySession, 'close'], { env, timeout: READY_TIMEOUT_MS, stdio: 'ignore' }) } catch (error) {
      report.cleanupError = `Browser cleanup failed: ${error.message}`
      report.status = 'failed'
    }
  }
  report.finishedAt = new Date().toISOString()
  await writeFile(path.join(output, 'results.json'), JSON.stringify(report, undefined, JSON_INDENT))
  console.log(`\nValidation ${report.status}: ${output}`)
  if (report.status !== 'passed') process.exitCode = 1
}

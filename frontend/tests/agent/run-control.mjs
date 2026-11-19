import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const CLI_TIMEOUT_MS = 30000
const SEEK_SECONDS = 10
const SIZES = [[1920, 1080], [1440, 900], [1024, 768], [390, 844]]
const output = path.resolve(import.meta.dirname, '../../../.audit-results', `phone-control-${new Date().toISOString().replace(/[:.]/g, '-')}`)
await mkdir(output, { recursive: true })
const cli = process.env.MUSIC_AGENT_BROWSER || 'agent-browser'
const base = `http://127.0.0.1:${process.env.MUSIC_AUDIT_PORT || 4179}`
const sessions = { host: 'control-audit-host', phone: 'control-audit-phone' }
const run = (role, ...args) => execFileSync(cli, ['--session', sessions[role], ...args], { encoding: 'utf8', timeout: CLI_TIMEOUT_MS })
const evaluate = (role, code) => run(role, 'eval', code)
const assert = (role, expression, message) => evaluate(role, `(() => { if (!(${expression})) throw new Error(${JSON.stringify(message)}); return 'PASS' })()`)
const wait = (role, expression) => run(role, 'wait', '--fn', expression)
const click = (role, selector) => run(role, 'click', selector)
const playing = 'window.__auditAudio.some(audio => !audio.paused)'
const paused = 'window.__auditAudio.every(audio => audio.paused)'
const reveal = role => run(role, 'mouse', 'move', '100', '4')
const playFirst = role => { run(role, 'hover', '.tile-wrap:first-child'); click(role, '.tile-wrap:first-child .tile-play button') }
let result = { status: 'running' }
try {
  run('host', 'open', base)
  run('phone', 'open', `${base}/?phone`)
  wait('phone', '!!document.querySelector(".control-switch") && !document.querySelector(".control-switch .status")')
  playFirst('phone')
  wait('host', playing)
  assert('phone', 'window.__auditCommands.every(command => command[0] !== "play")', 'Remote playback must never start phone audio')
  click('phone', 'button[aria-label="Queue and history"]')
  wait('phone', 'document.querySelectorAll(".now-playing .song").length === 2')
  click('phone', '.now-playing .song:nth-child(2) .select-song')
  wait('host', 'document.querySelector(".bar").textContent.includes("Included song 2")')
  click('phone', '.bar button[aria-label="Pause"]')
  wait('host', paused)
  run('phone', 'focus', '[aria-label="Seek"]')
  run('phone', 'press', 'Home')
  wait('host', 'window.__auditAudio[0].currentTime === 0')
  wait('phone', 'Number(document.querySelector("[aria-label=Seek]").getAttribute("aria-valuenow")) === 0')
  run('phone', 'press', 'ArrowRight')
  wait('host', `Math.abs(window.__auditAudio[0].currentTime - ${SEEK_SECONDS}) < 1`)
  assert('phone', paused, 'Seeking remotely must keep the phone silent')
  for (const [width, height] of SIZES) {
    run('phone', 'set', 'viewport', String(width), String(height))
    run('phone', 'screenshot', path.join(output, `${width}x${height}-queue.png`))
  }
  click('phone', 'button[aria-label="Close now playing"]')
  reveal('phone')
  click('phone', '[role="radio"]:text-is("This phone")')
  playFirst('phone')
  wait('phone', playing)
  assert('host', paused, 'Playing on the phone must leave the paused computer alone')
  reveal('phone')
  click('phone', '[role="radio"]:text-is("Computer")')
  wait('phone', paused)
  wait('phone', '!document.querySelector(".control-switch .status")')
  click('phone', '.bar button[aria-label="Play"]')
  wait('host', playing)
  assert('phone', paused, 'Returning to Computer must release all local audio')
  run('host', 'close')
  wait('phone', 'document.body.textContent.includes("Computer disconnected")')
  click('phone', '.bar button[aria-label="Play"]')
  wait('phone', 'document.body.textContent.includes("Reconnect before changing playback")')
  reveal('phone')
  run('phone', 'screenshot', path.join(output, '390x844-disconnected.png'))
  result = { status: 'passed', checks: ['remote play without local audio', 'full queue and jump', 'remote seek', 'destination handoff', 'disconnect feedback'], visualReview: 'pending' }
} catch (error) {
  result = { status: 'failed', error: error.message }
  try { run('phone', 'screenshot', path.join(output, 'failure.png')) } catch {}
  process.exitCode = 1
} finally {
  for (const role of ['phone', 'host']) { try { run(role, 'close') } catch {} }
  await writeFile(path.join(output, 'results.json'), JSON.stringify(result, undefined, 2))
  console.log(JSON.stringify(result))
  console.log(`Audit artifacts: ${output}`)
}

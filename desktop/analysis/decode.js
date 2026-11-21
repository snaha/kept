// Reads bounded excerpts of an audio file as mono float PCM through ffmpeg. The file is only read.
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'

const BYTES_PER_SAMPLE = Float32Array.BYTES_PER_ELEMENT
const STDERR_LIMIT = 300
const DURATION_PATTERN = /^  Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/m
const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 3600
const INPUT_UNAVAILABLE = /(?:No such file or directory|Permission denied|Operation not permitted|Input\/output error|Stale file handle|Device not configured|Transport endpoint is not connected)\r?$/im
export const indicatesUnavailableInput = diagnostic => typeof diagnostic === 'string' && INPUT_UNAVAILABLE.test(diagnostic)

// A file can disappear or become inaccessible after the queue's existence check.
const readable = file => access(file, constants.R_OK).then(() => true, () => false)

function run(command, args, { signal, probe = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], signal })
    const chunks = []
    let stderr = ''
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.stderr.on('data', chunk => { if (stderr.length < STDERR_LIMIT) stderr += chunk })
    child.on('error', reject)
    child.on('close', code => {
      // A duration probe has no output target and exits nonzero even for
      // readable files. Use stderr only to read duration, then decode for real.
      const unavailable = !probe && indicatesUnavailableInput(stderr)
      if ((code === 0 || (probe && Number.isInteger(code))) && !unavailable) resolve({ stdout: Buffer.concat(chunks), stderr })
      else reject(Object.assign(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, STDERR_LIMIT).trim()}`), {
        undecodable: Number.isInteger(code),
        unavailable,
      }))
    })
  })
}

/** The duration ffmpeg reports for a file in seconds, or 0. */
export async function probeDuration(ffmpeg, file, signal) {
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-i', file], { signal, probe: true })
  const match = DURATION_PATTERN.exec(stderr)
  return match ? Number(match[1]) * SECONDS_PER_HOUR + Number(match[2]) * SECONDS_PER_MINUTE + Number(match[3]) : 0
}

/** Where the excerpts of a track start: spread over it, or one from the start when it is short. */
export function excerptPlan(duration, { excerptSeconds, excerptPositions }) {
  const whole = !(duration >= excerptSeconds * (excerptPositions.length + 1))
  return whole
    ? [{ start: 0, seconds: excerptSeconds * excerptPositions.length }]
    : excerptPositions.map(position => ({ start: Math.max(0, duration * position - excerptSeconds / 2), seconds: excerptSeconds }))
}

/**
 * createDecoder(ffmpeg) -> decode({ file, duration, method, sampleRate, signal, rest }) -> Float32Array[]
 * One array per excerpt; excerpts shorter than a second are dropped.
 */
export const createDecoder = ffmpeg => async ({ file, duration, method, sampleRate, signal, rest }) => {
  const length = duration > 0 ? duration : await probeDuration(ffmpeg, file, signal)
  const excerpts = []
  for (const { start, seconds } of excerptPlan(length, method)) {
    const { stdout } = await run(ffmpeg, ['-v', 'error', '-nostdin', '-ss', start.toFixed(3), '-t', String(seconds), '-i', file, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', '-'], { signal }).catch(async error => {
      if (error.undecodable && !error.unavailable && !await readable(file)) error.unavailable = true
      throw error
    })
    const samples = new Float32Array(Math.floor(stdout.byteLength / BYTES_PER_SAMPLE))
    Buffer.from(samples.buffer).set(stdout.subarray(0, samples.byteLength))
    if (samples.length >= sampleRate) excerpts.push(samples)
    await rest?.()
  }
  if (!excerpts.length && !await readable(file)) throw Object.assign(new Error('Audio file is unavailable'), { unavailable: true })
  return excerpts
}

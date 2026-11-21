// Read-only access to the collection through the system ffmpeg/ffprobe.
import { spawn } from 'node:child_process'

const FFMPEG = process.env.FFMPEG ?? '/opt/homebrew/bin/ffmpeg'
const FFPROBE = process.env.FFPROBE ?? '/opt/homebrew/bin/ffprobe'
export const EXCERPT_SECONDS = 10
export const EXCERPT_POSITIONS = [0.2, 0.5, 0.8]
const BYTES_PER_SAMPLE = 4

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    let stderr = ''
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`${command} exited ${code}: ${stderr.slice(0, 200)}`))))
  })
}

export async function probe(file) {
  const json = JSON.parse((await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:format_tags:stream=codec_type:stream_tags', '-of', 'json', file])).toString())
  const tags = {}
  for (const source of [...(json.streams ?? []).filter(stream => stream.codec_type === 'audio').map(stream => stream.tags), json.format?.tags]) {
    for (const [key, value] of Object.entries(source ?? {})) tags[key.toLowerCase()] = String(value).trim()
  }
  return {
    duration: Number(json.format?.duration) || 0,
    artist: tags.artist ?? '',
    albumArtist: tags.album_artist ?? tags.albumartist ?? '',
    album: tags.album ?? '',
    title: tags.title ?? '',
    genre: tags.genre ?? '',
    compilation: tags.compilation === '1',
  }
}

/** Decodes bounded excerpts to mono float PCM at `sampleRate`; one Float32Array per excerpt. */
export async function decodeExcerpts(file, duration, sampleRate) {
  const whole = duration < EXCERPT_SECONDS * (EXCERPT_POSITIONS.length + 1)
  const starts = whole ? [0] : EXCERPT_POSITIONS.map(position => Math.max(0, duration * position - EXCERPT_SECONDS / 2))
  const length = whole ? EXCERPT_SECONDS * EXCERPT_POSITIONS.length : EXCERPT_SECONDS
  const excerpts = []
  for (const start of starts) {
    const pcm = await run(FFMPEG, ['-v', 'error', '-ss', start.toFixed(3), '-t', String(length), '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', '-'])
    const samples = new Float32Array(Math.floor(pcm.byteLength / BYTES_PER_SAMPLE))
    Buffer.from(samples.buffer).set(pcm.subarray(0, samples.byteLength))
    if (samples.length >= sampleRate) excerpts.push(samples)
  }
  return excerpts
}

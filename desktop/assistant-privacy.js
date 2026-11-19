// What may leave the machine for the optional assistant: the user's request, the tool schemas and
// tool results (IDs, scores, titles, artist names). Never audio, lyric text or a file path.
// Every outbound body passes through assertPrivatePayload before it is sent, and the test that
// intercepts a scripted session uses the same scan.
import os from 'node:os'

const MIN_AUDIO_BASE64 = 200
const AUDIO_EXTENSIONS = 'flac|mp3|m4a|aac|ogg|opus|wav|aiff?|wma|alac|ape|wv|mka'
// Two separators identify a nested path even when the root contains spaces or brackets.
// A lone inline slash can be title punctuation, as in "Zoveki /Lanternlight".
const NESTED_PATH = /(?:^|[\s"'`(<\[{=:,;]|\\+[nrt])\/(?![/\s])[^/"\\\r\n]*?(?<!\s)\//
const ROOT_PATH = /(?:(?:^|["'`(<\[{=]|\\+[nrt])\s*|\b(?:path|folder|directory|in|under|at|from|open|play|queue|put on)\s+)\/[^/\s"'`<>\\]/i
const CHECKS = [
  ['absolute path', NESTED_PATH],
  ['absolute path', ROOT_PATH],
  ['windows path', /(?<![A-Za-z0-9])[A-Za-z]:(?:\\+|\/(?!\/))[^\s"\\]/],
  ['file url', /file:\/\//i],
  ['home path', /(?:^|[\s"'`(=:,[])~\/[\w.-]+\//],
  ['audio file path', new RegExp(String.raw`[/\\][^/"\\\r\n]+\.(?:${AUDIO_EXTENSIONS})\b`, 'i')],
  ['audio bytes', new RegExp(`data:audio/|"type"\\s*:\\s*"audio"|[A-Za-z0-9+/]{${MIN_AUDIO_BASE64},}={0,2}`)],
  ['lyric field', /"(?:lyrics?|syncedLyrics|plainLyrics|lrc|lyricText)\\*"\s*:/i],
]

const variants = text => [text, JSON.stringify(text).slice(1, -1)]

// Names what a body contains that must not leave, never the content itself.
export function findPrivacyViolations(body, { folders = [], extra = [] } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const found = CHECKS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name)
  const secrets = [...folders, os.homedir(), ...extra].filter(value => typeof value === 'string' && value.length > 1)
  if (secrets.some(secret => variants(secret).some(variant => text.includes(variant)))) found.push('music folder')
  return [...new Set(found)]
}

export function assertPrivatePayload(body, options) {
  const found = findPrivacyViolations(body, options)
  if (found.length) throw new Error(`Not sent: the request would have contained private data (${found.join(', ')}). Only your request and the tool results leave your computer.`)
}

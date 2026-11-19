#!/usr/bin/env node
// Keeps real music libraries out of this public repository.
//
//   node scripts/check-private-data.mjs --all             every indexed file (CI)
//   node scripts/check-private-data.mjs --staged          what is about to be committed (pre-commit hook)
//   node scripts/check-private-data.mjs --range A...B     commits reachable from B but not A (pre-push hook)
//   node scripts/check-private-data.mjs --ref B           history reachable from B when there is no upstream
//   node scripts/check-private-data.mjs --ref B --exclude-remote R  history unreachable from R's tracking refs
//
// Always checked: no audio files beyond the synthetic fixtures below, no absolute home or sandbox
// paths, nothing under a git-ignored local fixture folder.
// Checked on your machine too: no name from your own library. List its folders, one per line, in
// .private-music at the repository root (git-ignored) or in KEPT_PRIVATE_MUSIC (separated by ':').
// Folder names, file names and, when ffprobe is installed, the artist, album and title tags become
// the forbidden terms. They are cached in .git and omitted from diagnostics.
// A false positive goes in .private-music-allow, one term per line (git-ignored too).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).replace(/\n$/, '')
const GIT_DIR = execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8', cwd: ROOT }).replace(/\n$/, '')
const CACHE = path.resolve(ROOT, GIT_DIR, 'kept-private-terms.json')
// Worktrees share the main checkout's lists, so one .private-music covers them all.
const MAIN_ROOT = path.dirname(path.resolve(ROOT, GIT_DIR))
const listed = name => [...new Set([ROOT, MAIN_ROOT])].flatMap(root => readList(path.join(root, name)))
const AUDIO = /\.(mp3|flac|m4a|mp4a|ogg|oga|opus|wav|aac|aiff?|wma|ape|alac|dsf|mka|wv|mpc|m4b|m4p|caf|webm|midi?)$/i
// Synthetic audio made for the tests. Anything else that sounds is someone's music.
const ALLOWED_AUDIO = new Set(['tagsmith/fixtures/tone.mp3'])
// Placeholder accounts the privacy tests use on purpose: a path under them is an example, not a leak.
const PLACEHOLDER = '(?:Shared|runner|example|someone|somebody|me|you|user|username|name|alice|bob|<[^>]*>)'
const PATH_BOUNDARY = String.raw`(?:[/\\]|$|[\s'"\x60)\]}])`
const ACCOUNT = String.raw`(?!${PLACEHOLDER}${PATH_BOUNDARY})[\p{L}\p{N}_.-]+(?=${PATH_BOUNDARY})`
const HOME_PATH = new RegExp(String.raw`(?:/Users/|/home/|[A-Za-z]:\\Users\\)${ACCOUNT}|/Volumes/(?!${PLACEHOLDER}${PATH_BOUNDARY})[^/]+/|/private/tmp/claude-|/private/var/folders/`, 'u')
const LOCAL_FIXTURES = /(^|\/)(fixtures\/local|test_library)\//
// The guard and its test spell out what they look for.
const SELF = new Set(['scripts/check-private-data.mjs', 'scripts/check-private-data.test.mjs'])
// Genres name a sound, not a library: a folder called 'Drum and Bass' is not a secret.
const GENRES = new Set(['drum and bass', 'drum & bass', 'hip hop', 'hip-hop', 'hard rock', 'new age', 'easy listening', 'rhythm and blues', 'r&b', 'trip hop', 'big beat', 'deep house', 'tech house', 'acid jazz', 'world music'])
const MIN_WORD = 5
const MIN_NAME = 6
const MIN_NAME_WORD = 4
const MIN_TITLE_WORDS = 3
const DICTIONARY = '/usr/share/dict/words'
// Words common enough in code and prose that a title made of them alone says nothing.
const COMMON = new Set(`intro outro interlude remix remixes version edit mix live the and feat featuring with from part vol volume acoustic instrumental original extended radio
  album albums track tracks single disc various artists artist unknown untitled bonus deluxe edition remaster remastered demo
  music songs song cover front back folder artwork scans booklet change inside broken legacy train pipeline flower poison
  default trance house techno dance mixed lounge ambient classical electronic other misc`.split(/\s+/).filter(Boolean))

const GIT_BUFFER_BYTES = 1024 ** 3
const GITLINK_MODE = '160000'
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', cwd: ROOT, maxBuffer: GIT_BUFFER_BYTES })
const lines = text => text.split('\n').filter(Boolean)
const paths = text => text.split('\0').filter(Boolean)

function readList(file) {
  return existsSync(file) ? lines(readFileSync(file, 'utf8')).map(line => line.trim()).filter(line => line && !line.startsWith('#')) : []
}

function privateFolders() {
  const fromEnv = (process.env.KEPT_PRIVATE_MUSIC || '').split(':').filter(Boolean)
  return [...fromEnv, ...listed('.private-music')].filter(folder => existsSync(folder))
}

// Audio files and the folders between them and the library root: an app's database bundle beside
// the music, or a stray document, is not part of what the library is called.
function walk(root, folder = root, out = new Set()) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || /\.(musiclibrary|localized|photoslibrary|app)$/i.test(entry.name)) continue
    const file = path.join(folder, entry.name)
    if (entry.isDirectory()) walk(root, file, out)
    else if (AUDIO.test(entry.name)) out.add(file)
  }
  return out
}

const WORD = /[\p{L}\p{N}]+/gu
const wordsOf = text => text.normalize('NFC').toLowerCase().match(WORD) ?? []

let dictionary
const isWord = term => {
  dictionary ??= new Set(existsSync(DICTIONARY) ? lines(readFileSync(DICTIONARY, 'utf8')).map(word => word.toLowerCase()) : [])
  return dictionary.has(term)
}

// A name cut the way libraries name things, each part with its role: in 'Artist - Album/07 - Title.mp3'
// the folders and everything before the last ' - ' name an act or a release, the rest is a title.
function partsOf(name, role) {
  const stem = name.replace(/\.[A-Za-z0-9]{2,5}$/, '')
  const pieces = stem.split(/ - | – |_-_/)
  const tidy = part => part.replace(/^[\d\s.\-_]+/, '').replace(/[\s\-_.,]+$/, '').trim()
  const roleOf = index => (role === 'title' && index === pieces.length - 1 ? 'title' : 'name')
  return [{ value: tidy(stem), role }, ...pieces.flatMap((piece, index) => [piece, ...piece.split(/[()[\]{}]/)].map(part => ({ value: tidy(part), role: roleOf(index) })))]
    .filter(({ value }) => value)
}

// An act or a release is distinctive even in plain words ('Glass Orchard', 'DJ Kestrel'); a title only
// when it is long or has a word no dictionary knows, or 'Run On' and 'Too Late' would fire in every file.
function keep({ value, role }) {
  const words = wordsOf(value)
  if (!words.length || words.every(word => /^\d+$/.test(word))) return false
  if (words.every(word => COMMON.has(word)) || GENRES.has(value.toLowerCase())) return false
  const unusual = words.some(word => word.length >= MIN_WORD && !COMMON.has(word) && !isWord(word))
  if (role === 'name') return words.length > 1 ? words.some(word => word.length >= MIN_NAME_WORD) : words[0].length >= MIN_NAME || unusual
  return words.length >= MIN_TITLE_WORDS || unusual
}

function probeTags(files) {
  try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }) } catch { return [] }
  return files.flatMap(file => {
    try {
      const out = execFileSync('ffprobe', ['-v', 'quiet', '-show_entries', 'format_tags=artist,album,title,album_artist', '-of', 'default=nw=1', file], { encoding: 'utf8' })
      return lines(out).map(line => line.match(/^TAG:(\w+)=(.*)$/)).filter(Boolean).map(([, key, value]) => ({ value, role: key === 'title' ? 'title' : 'name' }))
    } catch { return [] }
  })
}

function readCache() {
  try {
    const cached = JSON.parse(readFileSync(CACHE, 'utf8'))
    if (Array.isArray(cached?.terms) && cached.terms.every(term => typeof term === 'string')) return cached
  } catch {
    // The cache can be missing, unreadable or interrupted during a write. Rebuild it below.
  }
  return undefined
}

function privateTerms() {
  const folders = privateFolders()
  if (!folders.length) return undefined
  // A rename changes the terms even when it preserves every track's mtime.
  const identity = createHash('sha256')
  const files = folders.flatMap(folder => {
    identity.update(JSON.stringify(folder))
    return [...walk(folder)].sort().map(file => {
      const relative = path.relative(folder, file)
      identity.update(JSON.stringify([relative, statSync(file).mtimeMs]))
      return { file, relative }
    })
  })
  const signature = identity.digest('hex')
  const cached = readCache()
  let terms = cached?.signature === signature ? cached.terms : undefined
  if (!terms) {
    const names = files.flatMap(({ relative }) => relative.split(path.sep).map((part, index, all) => ({ value: part, role: index === all.length - 1 ? 'title' : 'name' })))
    const tagged = probeTags(files.map(({ file }) => file))
    const parts = [...names.flatMap(({ value, role }) => partsOf(value, role)), ...tagged.flatMap(({ value, role }) => partsOf(value, role))]
    terms = [...new Set(parts.filter(keep).map(({ value }) => value))]
    writeFileSync(CACHE, JSON.stringify({ signature, terms }), { mode: 0o600 })
  }
  const allowed = new Set(listed('.private-music-allow').map(term => term.normalize('NFC').toLowerCase()))
  return terms.filter(term => !allowed.has(term.normalize('NFC').toLowerCase()))
}

// Terms indexed by their first word: a line is only compared with the terms that start with one of
// its words, and a term matches whole words only, so 'Orchard' does not fire inside 'Orchards'.
function matcher(terms) {
  if (!terms?.length) return () => undefined
  const index = new Map()
  for (const term of terms) {
    const words = wordsOf(term)
    if (!words.length) continue
    const list = index.get(words[0]) ?? []
    list.push({ term, words })
    index.set(words[0], list)
  }
  return text => {
    const words = wordsOf(text)
    for (let at = 0; at < words.length; at++) {
      for (const { term, words: wanted } of index.get(words[at]) ?? []) {
        if (wanted.every((word, offset) => words[at + offset] === word)) return term
      }
    }
    return undefined
  }
}

const GIT_PATH_ESCAPES = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '"': '"', '\\': '\\' }
const OCTAL_RADIX = 8

function patchPath(header) {
  const file = header.slice('+++ '.length).replace(/\t$/, '')
  if (file === '/dev/null') return undefined
  // Git still C-quotes control characters, quotes and backslashes with core.quotepath off.
  if (file.startsWith('"')) {
    return file.slice(1, -1).replace(/\\([0-7]{3}|[abtnvfr"\\])/g, (_, escape) =>
      GIT_PATH_ESCAPES[escape] ?? String.fromCharCode(Number.parseInt(escape, OCTAL_RADIX)))
  }
  return file
}

function indexed() {
  const entries = paths(git('ls-files', '--stage', '-z')).map(entry => {
    const tab = entry.indexOf('\t')
    const [mode, oid] = entry.slice(0, tab).split(' ')
    return { mode, oid, file: entry.slice(tab + 1) }
  })
  const files = entries.map(({ file }) => file)
  const blobs = entries.filter(({ mode, file }) => mode !== GITLINK_MODE && !AUDIO.test(file) && !SELF.has(file))
  const contents = execFileSync('git', ['cat-file', '--batch'], {
    cwd: ROOT,
    maxBuffer: GIT_BUFFER_BYTES,
    input: blobs.map(({ oid }) => `${oid}\n`).join(''),
  })
  const rows = []
  let offset = 0
  for (const { file } of blobs) {
    const headerEnd = contents.indexOf('\n', offset)
    const [, type, size] = contents.toString('ascii', offset, headerEnd).split(' ')
    const start = headerEnd + 1
    const end = start + Number(size)
    if (type !== 'blob' || !Number.isSafeInteger(end) || end >= contents.length) throw new Error('Unable to read an indexed blob')
    const content = contents.subarray(start, end)
    offset = end + 1
    if (content.includes(0)) continue
    content.toString('utf8').split('\n').forEach((text, index) => rows.push({ file, line: index + 1, text }))
  }
  return { files, rows, messages: [] }
}

// Compare every new commit with its first parent, including changes created by the merge itself.
function added(mode, revisions) {
  const source = mode === 'staged'
    ? ['diff', '--cached']
    : ['log', '--format=', '--no-notes', '--no-show-signature', '--root', '--diff-merges=first-parent', ...revisions]
  const diffArgs = [...source, '--no-ext-diff', '--no-textconv', '--submodule=short', '--find-renames', '--diff-filter=ACMRT']
  const files = [...new Set(paths(git(...diffArgs, '--name-only', '-z', '--')))]
  const rows = []
  let file
  let line
  const patch = git('-c', 'core.quotepath=off', ...diffArgs, '--no-prefix', '--unified=0', '--no-color', '--')
  for (const text of patch.split('\n')) {
    if (text.startsWith('diff --git ')) {
      file = undefined
      line = undefined
    } else if (line === undefined && text.startsWith('+++ ')) {
      file = patchPath(text)
    } else {
      const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)
      if (hunk) line = Number(hunk[1])
      else if (file !== undefined && line !== undefined) {
        if (text.startsWith('+')) rows.push({ file, line, text: text.slice(1) })
        if (text.startsWith('+') || text.startsWith(' ')) line++
      }
    }
  }
  const messages = mode === 'range'
    ? paths(git('log', '-z', '--no-notes', '--no-show-signature', '--no-patch', '--format=%h%n%B', ...revisions, '--'))
    : []
  return { files, rows, messages }
}

const args = process.argv.slice(2)
const mode = args.includes('--all') ? 'all' : args.includes('--staged') ? 'staged' : 'range'
const range = args.includes('--range') ? args[args.indexOf('--range') + 1] : 'origin/main...HEAD'
const ref = args.includes('--ref') ? args[args.indexOf('--ref') + 1] : undefined
const remote = args.includes('--exclude-remote') ? args[args.indexOf('--exclude-remote') + 1] : undefined
const revisions = ref && remote ? [ref, '--not', `--remotes=${remote}`] : [ref ?? range.replace('...', '..')]
const { files, rows, messages } = mode === 'all' ? indexed() : added(mode, revisions)
const privateMatch = matcher(privateTerms())
// Matched names stay out of the output unless asked for, so a hook run inside an agent's session
// does not copy them into its transcript. --show-terms prints them here, to allow a false positive.
const SHOW_TERMS = args.includes('--show-terms')
const named = term => (SHOW_TERMS ? ` ("${term}")` : '')
const problems = []
const ABSOLUTE_PATH_PROBLEM = 'an absolute home or sandbox path (use a placeholder or os.tmpdir())'

function displayPath(file) {
  if (privateMatch(file) && !SHOW_TERMS) return 'a changed path containing a name from your library'
  return /[\x00-\x1F\x7F-\x9F]/.test(file) ? JSON.stringify(file) : file
}

for (const file of files) {
  if (AUDIO.test(file) && !ALLOWED_AUDIO.has(file)) problems.push(`${displayPath(file)}: audio file outside the synthetic fixture allowlist (see AGENTS.md, Private music)`)
  if (LOCAL_FIXTURES.test(file)) problems.push(`${displayPath(file)}: local fixtures describe a private library and stay out of git`)
  const pathTerm = privateMatch(file)
  if (pathTerm) problems.push(SHOW_TERMS ? `${displayPath(file)}: the path contains a name from your library${named(pathTerm)}` : 'a changed path contains a name from your library')
}
for (const { file, line, text } of rows) {
  if (SELF.has(file)) continue
  if (HOME_PATH.test(text)) problems.push(`${displayPath(file)}:${line}: ${ABSOLUTE_PATH_PROBLEM}`)
  const textTerm = privateMatch(text)
  if (textTerm) problems.push(`${displayPath(file)}:${line}: contains a name from your library${named(textTerm)}`)
}
for (const message of messages) {
  const endOfHash = message.indexOf('\n')
  const commit = `commit ${message.slice(0, endOfHash)}`
  const body = message.slice(endOfHash + 1)
  if (HOME_PATH.test(body)) problems.push(`${commit}: ${ABSOLUTE_PATH_PROBLEM}`)
  const messageTerm = privateMatch(body)
  if (messageTerm) problems.push(`${commit}: contains a name from your library${named(messageTerm)}`)
}

if (problems.length) {
  console.error(`Private music check failed (${problems.length}):\n${problems.map(problem => `  ${problem}`).join('\n')}`)
  console.error('Real libraries are for local runs only. Use fictional names, synthetic audio or public-domain recordings (AGENTS.md, Private music).')
  if (!SHOW_TERMS && problems.some(problem => problem.includes('name from your library'))) console.error('Run again with --show-terms to see the matched names here; add a false positive to .private-music-allow.')
  process.exit(1)
}

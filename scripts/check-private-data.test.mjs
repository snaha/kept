import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The guard against a throwaway repository and an invented library: a name from the library, a home
// path or a stray audio file is refused; fictional names and placeholder paths go through.
const SCRIPT = new URL('./check-private-data.mjs', import.meta.url)
const PRE_PUSH = fileURLToPath(new URL('../.githooks/pre-push', import.meta.url))
const SILENT_MP3 = Buffer.from('ID3')
const LARGE_LIBRARY_SIZE = 200_000
const FIXTURE_ENV = {
  ...process.env,
  KEPT_PRIVATE_MUSIC: '',
  GIT_AUTHOR_NAME: 'Guard',
  GIT_AUTHOR_EMAIL: 'guard@example.com',
  GIT_COMMITTER_NAME: 'Guard',
  GIT_COMMITTER_EMAIL: 'guard@example.com',
}

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'kept-guard-'))
  const repo = path.join(root, 'repo')
  const library = path.join(root, 'library')
  const album = path.join(library, 'Quillon Marsh - Velvet Cartography')
  mkdirSync(album, { recursive: true })
  writeFileSync(path.join(album, '01 - Lanterns Over Ostrava.mp3'), SILENT_MP3)
  // A short act in dictionary words, and lyrics filler that must not count as one.
  writeFileSync(path.join(library, 'DJ Fern - La La.mp3'), SILENT_MP3)
  mkdirSync(path.join(repo, 'scripts'), { recursive: true })
  copyFileSync(SCRIPT, path.join(repo, 'scripts', 'check-private-data.mjs'))
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe', env: FIXTURE_ENV }).trim()
  git('init', '-q')
  writeFileSync(path.join(repo, '.private-music'), `${library}\n`)
  return { root, repo, library, git }
}

function run(repo, command, args, input) {
  const result = spawnSync(command, args, { cwd: repo, encoding: 'utf8', env: FIXTURE_ENV, input })
  assert.ifError(result.error)
  return { ok: result.status === 0, out: result.stderr }
}

const check = (repo, ...args) => {
  // The library's files hold no tags, so its names come from its folders and files alone.
  return run(repo, process.execPath, ['scripts/check-private-data.mjs', ...args])
}

const commit = (git, message, ...parents) =>
  git('commit-tree', git('write-tree'), '-m', message, ...parents.flatMap(parent => ['-p', parent]))

test('a staged name from the private library is refused, an invented one is not', () => {
  const { root, repo, git } = setup()
  try {
    writeFileSync(path.join(repo, 'fixture.js'), "export const ALBUM = { artist: 'Harbor Lights', title: 'Paper Lanterns' }\n")
    git('add', 'fixture.js')
    assert.equal(check(repo, '--staged').ok, true)

    writeFileSync(path.join(repo, 'fixture.js'), "export const ALBUM = { artist: 'Quillon Marsh', title: 'Velvet Cartography' }\n")
    git('add', 'fixture.js')
    const refused = check(repo, '--staged')
    assert.equal(refused.ok, false)
    assert.match(refused.out, /fixture\.js:1: contains a name from your library/)
    assert.doesNotMatch(refused.out, /Quillon Marsh|Velvet Cartography/)
    assert.match(refused.out, /--show-terms/)
    assert.match(check(repo, '--staged', '--show-terms').out, /fixture\.js:1: contains a name from your library \("(Quillon Marsh|Velvet Cartography)"\)/, 'asked for, the matched name is shown')

    writeFileSync(path.join(repo, 'fixture.js'), "export const CREDIT = 'DJ Fern'\n")
    git('add', 'fixture.js')
    assert.match(check(repo, '--staged').out, /fixture\.js:1: contains a name from your library/)
    writeFileSync(path.join(repo, 'fixture.js'), "export const LYRICS = 'la la'\n")
    git('add', 'fixture.js')
    assert.equal(check(repo, '--staged').ok, true, 'two-letter filler is not a name')

    writeFileSync(path.join(repo, 'fixture.js'), "export const ALBUM = { artist: 'Quillon Marsh', title: 'Velvet Cartography' }\n")
    git('add', 'fixture.js')
    writeFileSync(path.join(repo, '.private-music-allow'), 'Quillon Marsh\nVelvet Cartography\nQuillon Marsh - Velvet Cartography\n')
    assert.equal(check(repo, '--staged').ok, true, 'an allowed term is not reported')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('home paths, sandbox paths and audio are refused everywhere, placeholders are not', () => {
  const { root, repo, git } = setup()
  try {
    writeFileSync(path.join(repo, 'example.js'), "export const PATHS = ['/Users/example/Music', '/home/someone/Music', '~/Music']\n")
    git('add', 'example.js')
    assert.equal(check(repo, '--staged').ok, true)

    writeFileSync(path.join(repo, 'leak.md'), 'Measured on /Users/quillon/Music, in /private/tmp/claude-501/x\n')
    writeFileSync(path.join(repo, 'song.flac'), SILENT_MP3)
    git('add', 'leak.md', 'song.flac')
    const refused = check(repo, '--staged')
    assert.equal(refused.ok, false)
    assert.match(refused.out, /leak\.md:1: an absolute home or sandbox path/)
    assert.match(refused.out, /song\.flac: audio file/)

    rmSync(path.join(repo, '.private-music'))
    assert.equal(check(repo, '--all').ok, false, 'CI finds the same without a library list')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a full scan rejects indexed paths in a docs-only change and a dangling symlink', t => {
  const { root, repo, git } = setup()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  rmSync(path.join(repo, '.private-music'))
  const note = 'docs/fixture.md'
  const link = 'fixture-link'
  const privatePath = '/Users/qzvx-guard-fixture/library'
  mkdirSync(path.join(repo, 'docs'))
  writeFileSync(path.join(repo, note), `${privatePath}\n`)
  git('add', '--', note)
  writeFileSync(path.join(repo, note), 'clean working copy\n')
  const docsOnly = check(repo, '--all')
  assert.equal(docsOnly.ok, false)
  assert.match(docsOnly.out, /docs\/fixture\.md:1: an absolute home or sandbox path/)

  git('add', '--', note)
  symlinkSync(privatePath, path.join(repo, link))
  git('add', '--', link)
  const dangling = check(repo, '--all')
  assert.equal(dangling.ok, false)
  assert.match(dangling.out, /fixture-link:1: an absolute home or sandbox path/)
  assert.ok(!dangling.out.includes(privatePath), dangling.out)
})

test('Unicode audio and private filenames are refused in staged, range and all scans', t => {
  const { root, repo, library, git } = setup()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const base = commit(git, 'test: empty tree')
  const album = 'Qelvrixo Café'
  mkdirSync(path.join(library, album))
  writeFileSync(path.join(library, album, '01.mp3'), SILENT_MP3)
  const audio = 'fixture-é.mp3'
  const note = `${album.normalize('NFD')}.md`
  writeFileSync(path.join(repo, audio), SILENT_MP3)
  writeFileSync(path.join(repo, note), 'synthetic fixture\n')
  git('add', '--all', '--', audio, note)
  const head = commit(git, 'test: add fixtures', base)

  for (const args of [['--staged'], ['--range', `${base}...${head}`], ['--all']]) {
    const refused = check(repo, ...args)
    assert.equal(refused.ok, false)
    assert.ok(refused.out.normalize('NFC').includes(`${audio}: audio file`), refused.out)
    assert.match(refused.out, /a changed path contains a name from your library/)
    assert.doesNotMatch(refused.out, /Qelvrixo/)
  }
})

test('a line beginning with two plus signs and the following line keep their file and line numbers', t => {
  const { root, repo, git } = setup()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = 'space in name.txt'
  writeFileSync(path.join(repo, file), '++ /Users/qzvx-guard-fixture/library\n/Users/qzvx-guard-fixture/output\n')
  git('add', '--', file)

  const refused = check(repo, '--staged')
  assert.equal(refused.ok, false)
  for (const line of [1, 2]) {
    assert.ok(refused.out.includes(`${file}:${line}: an absolute home or sandbox path`), refused.out)
  }
})

test('a rename scans added lines under the destination even when it contains Git-quoted characters', t => {
  const { root, repo, git } = setup()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = 'old-name.txt'
  const destination = 'renamed "é"\tline\nslash\\.txt'
  const content = 'An existing synthetic note that should survive the rename.\n'
  writeFileSync(path.join(repo, source), content)
  git('add', '--', source)
  const base = commit(git, 'test: add original note')
  rmSync(path.join(repo, source))
  writeFileSync(path.join(repo, destination), `${content}/Users/qzvx-guard-fixture/library\n`)
  git('add', '--all', '--', source, destination)
  const head = commit(git, 'test: rename note', base)
  assert.match(git('diff', '--find-renames', '--name-status', base, head), /^R/)

  const refused = check(repo, '--range', `${base}...${head}`)
  assert.equal(refused.ok, false)
  assert.ok(refused.out.normalize('NFC').includes(`${JSON.stringify(destination)}:2: an absolute home or sandbox path`), refused.out)
})

test('a large private library still detects a staged name', t => {
  const { root, repo, library, git } = setup()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // Virtual numbered tracks keep the large-directory check independent of disk and ffprobe cost.
  const preload = `
    import fs from 'node:fs'
    import childProcess from 'node:child_process'
    import path from 'node:path'
    import { syncBuiltinESMExports } from 'node:module'
    const library = ${JSON.stringify(library)}
    const { readdirSync, statSync } = fs
    const { execFileSync } = childProcess
    fs.readdirSync = (dir, options) => {
      const entries = readdirSync(dir, options)
      if (dir !== library) return entries
      return entries.concat(Array.from({ length: ${LARGE_LIBRARY_SIZE} }, (_, index) => ({
        name: index + '.mp3',
        isDirectory: () => false,
      })))
    }
    fs.statSync = file => {
      if (path.dirname(file) === library && /^\\d+\\.mp3$/.test(path.basename(file))) return { mtimeMs: 1 }
      return statSync(file)
    }
    childProcess.execFileSync = (file, args, options) => {
      if (file === 'ffprobe') throw new Error('ffprobe is unavailable in this fixture')
      return execFileSync(file, args, options)
    }
    syncBuiltinESMExports()
  `
  writeFileSync(path.join(repo, 'note.txt'), 'Quillon Marsh\n')
  git('add', '--', 'note.txt')

  const refused = run(repo, process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(preload)}`, 'scripts/check-private-data.mjs', '--staged',
  ])
  assert.equal(refused.ok, false)
  assert.match(refused.out, /note\.txt:1: contains a name from your library/)
})

test('pre-push scans the pushed ref and its root message when a new remote has no main', t => {
  const { root, repo, git } = setup()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const audio = 'fixture.mp3'
  writeFileSync(path.join(repo, audio), SILENT_MP3)
  git('add', '--', audio)
  const head = commit(git, 'test: fixture\n\nQuillon Marsh')
  git('rm', '-f', '--', audio)
  const zero = '0'.repeat(head.length)
  const input = `refs/heads/fixture ${head} refs/heads/fixture ${zero}\n(delete) ${zero} refs/heads/deleted ${head}\n`

  const refused = run(repo, 'sh', [PRE_PUSH, 'fixture-remote'], input)
  assert.equal(refused.ok, false)
  assert.match(refused.out, /fixture\.mp3: audio file/)
  assert.ok(refused.out.includes(`commit ${git('rev-parse', '--short', head)}: contains a name from your library`), refused.out)
  assert.doesNotMatch(refused.out, /Quillon Marsh|fatal:/)
  assert.equal(run(repo, 'sh', [PRE_PUSH, 'fixture-remote'], `(delete) ${zero} refs/heads/deleted ${head}\n`).ok, true)
})

test('pre-push uses the remote ref for an update and skips its existing changes', t => {
  const { root, repo, git } = setup()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(path.join(repo, 'old-fixture.mp3'), SILENT_MP3)
  git('add', '--', 'old-fixture.mp3')
  const base = commit(git, 'test: existing remote tree')
  const clean = commit(git, 'test: clean update', base)
  const leaked = commit(git, 'test: Quillon Marsh', base)
  const push = head => run(repo, 'sh', [PRE_PUSH, 'fixture-remote'], `refs/heads/fixture ${head} refs/heads/fixture ${base}\n`)

  assert.equal(push(clean).ok, true)
  const refused = push(leaked)
  assert.equal(refused.ok, false)
  assert.match(refused.out, /commit [\da-f]+: contains a name from your library/)
})

test('pre-push on a new ref excludes history tracked for the destination only', t => {
  const { root, repo, git } = setup()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const base = commit(git, 'test: initial tree')
  const audio = 'published-fixture.mp3'
  const privatePath = '/Users/qzvx-guard-fixture/library'
  writeFileSync(path.join(repo, audio), SILENT_MP3)
  git('add', '--', audio)
  const added = commit(git, `test: add fixture\n\n${privatePath}`, base)
  git('rm', '-f', '--', audio)
  const published = commit(git, 'test: remove fixture', added)
  git('update-ref', 'refs/remotes/fixture-remote/main', base)
  git('update-ref', 'refs/remotes/fixture-remote/published', published)

  const clean = commit(git, 'test: clean update', published)
  const foreign = commit(git, `test: other remote only\n\n${privatePath}`, clean)
  git('update-ref', 'refs/remotes/other-remote/fixture', foreign)
  const push = head => run(repo, 'sh', [PRE_PUSH, 'fixture-remote'], `refs/heads/fixture ${head} refs/heads/fixture ${'0'.repeat(head.length)}\n`)

  const accepted = push(clean)
  assert.equal(accepted.ok, true, accepted.out)
  const refused = push(foreign)
  assert.equal(refused.ok, false)
  assert.ok(refused.out.includes(`commit ${git('rev-parse', '--short', foreign)}: an absolute home or sandbox path`), refused.out)
})

test('pre-push rejects files added and removed within the pushed history', t => {
  const { root, repo, git } = setup()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const base = commit(git, 'test: initial tree')
  const audio = 'fixture.mp3'
  const note = 'fixture.md'
  writeFileSync(path.join(repo, audio), SILENT_MP3)
  writeFileSync(path.join(repo, note), '/Users/qzvx-guard-fixture/library\n')
  git('add', '--', audio, note)
  const added = commit(git, 'test: add fixtures', base)
  git('rm', '-f', '--', audio, note)
  const head = commit(git, 'test: remove fixtures', added)

  for (const upstream of [base, '0'.repeat(base.length)]) {
    const input = `refs/heads/fixture ${head} refs/heads/fixture ${upstream}\n`
    const refused = run(repo, 'sh', [PRE_PUSH, 'fixture-remote'], input)
    assert.equal(refused.ok, false)
    assert.match(refused.out, /fixture\.mp3: audio file/)
    assert.match(refused.out, /fixture\.md:1: an absolute home or sandbox path/)
  }
})

test('pre-push rejects a private path in a commit body without a library list', t => {
  const { root, repo, git } = setup()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  rmSync(path.join(repo, '.private-music'))
  const base = commit(git, 'test: initial tree')
  const privatePath = '/Users/qzvx-guard-fixture/library'
  const head = commit(git, `test: update fixture\n\nRun from ${privatePath}`, base)
  const input = `refs/heads/fixture ${head} refs/heads/fixture ${base}\n`

  const refused = run(repo, 'sh', [PRE_PUSH, 'fixture-remote'], input)
  assert.equal(refused.ok, false)
  assert.ok(refused.out.includes(`commit ${git('rev-parse', '--short', head)}: an absolute home or sandbox path`), refused.out)
  assert.ok(!refused.out.includes(privatePath), refused.out)
})

test('additional audio formats and absolute library paths are refused', t => {
  const { root, repo, git } = setup()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const audio = ['mka', 'wv', 'mpc', 'm4b', 'm4p', 'caf', 'webm', 'mid', 'midi']
    .map(extension => `fixture.${extension}`)
  for (const file of audio) writeFileSync(path.join(repo, file), SILENT_MP3)
  const privatePaths = ['/Volumes/QZVX Fixture/Library', 'Q:/Users/qzvx-guard-fixture/Library', '/Users/qzvx-guard-fixture']
  const placeholderPaths = ['/Volumes/example/Library', 'Q:/Users/example/Library', '/Users/example']
  writeFileSync(path.join(repo, 'paths.txt'), [...privatePaths, ...placeholderPaths].join('\n'))
  git('add', '--', ...audio, 'paths.txt')

  const refused = check(repo, '--staged')
  assert.equal(refused.ok, false)
  for (const file of audio) assert.ok(refused.out.includes(`${file}: audio file`), refused.out)
  assert.deepEqual(refused.out.match(/paths\.txt:\d+: an absolute home or sandbox path/g),
    privatePaths.map((_, index) => `paths.txt:${index + 1}: an absolute home or sandbox path`))
})

test('a damaged cache is rebuilt and private names are still refused', t => {
  const { root, repo, git } = setup()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cache = path.join(repo, '.git', 'kept-private-terms.json')
  writeFileSync(cache, '{')
  writeFileSync(path.join(repo, 'note.txt'), 'Velvet Cartography\n')
  git('add', '--', 'note.txt')

  const refused = check(repo, '--staged')
  assert.equal(refused.ok, false)
  assert.match(refused.out, /note\.txt:1: contains a name from your library/)
  assert.doesNotMatch(refused.out, /Velvet Cartography|SyntaxError/)
})

test('renaming a library directory invalidates a warm cache', t => {
  const { root, repo, library, git } = setup()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const newAlbum = 'Qyzvexa Cartulith'
  const oldAlbum = 'Quillon Marsh - Velvet Cartography'
  writeFileSync(path.join(repo, 'note.txt'), `${newAlbum}\n`)
  git('add', '--', 'note.txt')
  assert.equal(check(repo, '--staged').ok, true)

  renameSync(path.join(library, oldAlbum), path.join(library, newAlbum))
  const refused = check(repo, '--staged')
  assert.equal(refused.ok, false)
  assert.match(refused.out, /note\.txt:1: contains a name from your library/)
})

test('the public validation notes omit track-level playback timings', () => {
  for (const file of ['core-validation.md', 'pr-drafts/core.md']) {
    const notes = readFileSync(new URL(`../docs/${file}`, import.meta.url), 'utf8')
    const journeys = notes.split(/\n\s*\n/).filter(paragraph => /\btrack\b/.test(paragraph) && /\b(?:decoded|playback)\b/.test(paragraph))
    for (const journey of journeys) {
      assert.ok(!/\b\d+(?:\.\d+)?(?:\s+|-)seconds?\b/i.test(journey), `${file} gives a track-level playback timing`)
    }
  }
})

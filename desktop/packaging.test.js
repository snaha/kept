import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

// Walks the static import graph from main.js, following imports, re-exports, dynamic imports of
// literals and `new URL('./file', import.meta.url)` references (workers, utility processes, job
// modules), and fails when a reachable local file is not shipped by the packaging lists.

const here = import.meta.dirname
const repo = path.resolve(here, '..')
const pkg = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'))
const ENTRIES = ['main.js']
// Optional at runtime: embedded-tags.js loads the bundled Tagsmith reader (build:preload) and warns, then goes on, without it.
const OPTIONAL = new Set(['tagsmith-read.js', '../tagsmith/dist/read.js', '../tagsmith/src/read.ts'])
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|new URL\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/g
const SHIPPED_EXTENSIONS = /\.(?:js|mjs|json)$/

const globToRegExp = glob => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '(?:.*/)?')}$`)

const appPatterns = pkg.build.files.filter(entry => !entry.startsWith('!')).map(globToRegExp)
const shared = pkg.build.extraResources.find(entry => entry.from === '../shared')
const sharedFiles = new Set(shared?.filter ?? [])

const shipped = file => {
  const relative = path.relative(here, file).split(path.sep).join('/')
  if (!relative.startsWith('../')) return appPatterns.some(pattern => pattern.test(relative))
  const parts = path.relative(repo, file).split(path.sep)
  return parts[0] === 'shared' && parts.length === 2 && sharedFiles.has(parts[1])
}

const reachable = () => {
  const seen = new Set()
  const missing = []
  const queue = ENTRIES.map(entry => path.join(here, entry))
  while (queue.length) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    if (!SHIPPED_EXTENSIONS.test(file) || !existsSync(file)) continue
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(SPECIFIER)) {
      const target = path.resolve(path.dirname(file), match[2])
      if (OPTIONAL.has(path.relative(here, target).split(path.sep).join('/'))) continue
      if (!existsSync(target)) continue
      queue.push(target)
    }
    // Strings naming sibling files, such as the entry list of the optional tag reader, are listed in OPTIONAL.
  }
  for (const file of seen) if (!shipped(file) && !/\.(?:test\.js)$/.test(file)) missing.push(path.relative(repo, file))
  return { seen, missing }
}

test('every local file reachable from main.js is in the packaging lists', () => {
  const { seen, missing } = reachable()
  assert.ok(seen.size > 30, `walked only ${seen.size} files`)
  assert.deepEqual(missing, [])
})

test('the preload bundle and frontend build are packaged', () => {
  assert.ok(pkg.build.files.includes('preload.bundle.cjs'))
  assert.ok(pkg.build.files.includes('dist/**/*'))
})

test('release builds ship the bundled ffmpeg and models, and never the system ffmpeg', () => {
  const resources = pkg.build.extraResources.map(entry => entry.to)
  for (const name of ['navidrome', 'ffmpeg', 'models', 'shared']) assert.ok(resources.includes(name), name)
  const source = readFileSync(path.join(here, 'analysis', 'ffmpeg.js'), 'utf8')
  assert.match(source, /packaged/)
})

test('the Tagsmith reader bundle is packaged and its builder produces it', () => {
  assert.ok(pkg.build.files.includes('tagsmith-read.js'))
  assert.match(readFileSync(path.join(here, 'scripts', 'build-preload.mjs'), 'utf8'), /tagsmith-read\.js/)
  assert.match(readFileSync(path.join(here, 'embedded-tags.js'), 'utf8'), /'\.\/tagsmith-read\.js'/)
})

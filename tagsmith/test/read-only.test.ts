import { copyFile, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { fetcher, identify, inventory, plan, stats } from '../src/read.ts'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '../src')
const FORBIDDEN = ['apply.ts', 'write.ts', 'cli.ts', 'decisions-file.ts', 'node-taglib-sharp']
const IMPORT = /from '([^']+)'/g

const reachable = async (entry: string): Promise<Set<string>> => {
  const seen = new Set<string>()
  const visit = async (file: string): Promise<void> => {
    if (seen.has(file)) return
    seen.add(file)
    for (const [, spec] of (await readFile(join(src, file), 'utf8')).matchAll(IMPORT)) {
      if (spec.startsWith('.')) await visit(spec.replace(/^\.\//, ''))
      else seen.add(spec)
    }
  }
  await visit(entry)
  return seen
}

let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

test('no write path is reachable from the read-only entry', async () => {
  const modules = await reachable('read.ts')
  for (const forbidden of FORBIDDEN) expect([...modules].filter((m) => m.includes(forbidden))).toEqual([])
  expect(modules.has('node:child_process')).toBe(true) // only ffmpeg loudness, which reads
})

test('inventory, plan and identify leave a library untouched and write no files', async () => {
  dir = await mkdtemp(join(tmpdir(), 'tagsmith-read-'))
  const album = join(dir, 'library', 'Artist - Album')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(album, { recursive: true })
  const names = ['01 Tone.mp3', '02 Tone.mp3', '03 Tone.mp3']
  for (const name of names) await copyFile(resolve(here, '../fixtures/tone.mp3'), join(album, name))
  const before = await readFile(join(album, '01 Tone.mp3'))
  const stamp = (await stat(join(album, '01 Tone.mp3'))).mtimeMs

  const inv = await inventory([join(dir, 'library')])
  const { decisions } = plan(inv)
  expect(decisions.length).toBe(names.length)
  expect(stats(decisions).files).toBe(names.length)
  const found = await identify(inv, decisions, { net: fetcher(undefined, { offline: true }), steps: ['musicbrainz', 'covers', 'lyrics'] })
  expect(Object.keys(found.albums)).toEqual([])

  expect(await readFile(join(album, '01 Tone.mp3'))).toEqual(before)
  expect((await stat(join(album, '01 Tone.mp3'))).mtimeMs).toBe(stamp)
  expect((await readdir(album)).sort()).toEqual(names)
  expect(await readdir(dir)).toEqual(['library'])
})

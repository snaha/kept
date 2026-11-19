import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { prepareMusicRoot } from './music-folders.js'
import { createTrackPathResolver, RESOLVED_BY } from './track-paths.js'

const linkName = (root, folder) => readdirSync(root).find((name) => readlinkSync(path.join(root, name)) === folder)
const touch = (file) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, 'x') }

const fixture = (t, { combined = true } = {}) => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'track-paths-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const profile = path.join(base, 'profile')
  const music = path.join(base, 'Music')
  const archive = path.join(base, 'Archive')
  mkdirSync(profile)
  const a = path.join(music, 'Artist', 'Album', '01 Song.mp3')
  const b = path.join(archive, 'Other', 'Disc', '02 Tune.flac')
  const accented = path.join(archive, 'Café', 'Déjà vu.mp3')
  for (const file of [a, b, accented]) touch(file)
  const folders = [music, archive]
  const root = prepareMusicRoot(profile, folders, combined)
  return { base, root, folders, music, archive, a, b, accented, resolver: createTrackPathResolver({ root, folders, combined }) }
}

test('a reported path under the symlink root resolves to the real file', (t) => {
  const { root, folders, a, b, resolver } = fixture(t)
  for (const file of [a, b]) {
    const folder = folders.find((candidate) => file.startsWith(candidate + path.sep))
    const reported = path.join(root, linkName(root, folder), path.relative(folder, file))
    const result = resolver.resolve({ id: file, path: reported })
    assert.deepEqual([result.file, result.by], [file, RESOLVED_BY.reported])
  }
})

test('a single uncombined root reports the real path directly', (t) => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'track-paths-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const music = path.join(base, 'Music')
  const file = path.join(music, 'Artist', 'Song.mp3')
  touch(file)
  const resolver = createTrackPathResolver({ root: music, folders: [music] })
  assert.deepEqual(resolver.resolve({ id: '1', path: file }), { id: '1', file, by: RESOLVED_BY.reported })
})

test('a symlinked music root still maps back to the real folder', (t) => {
  const { base, root, folders, a } = fixture(t)
  const alias = path.join(base, 'alias-root')
  symlinkSync(root, alias)
  const resolver = createTrackPathResolver({ root: alias, folders })
  const name = linkName(root, folders[0])
  const result = resolver.resolve({ id: 'a', path: path.join(alias, name, 'Artist', 'Album', '01 Song.mp3') })
  assert.equal(result.file, a)
})

test('without the flag a relative path joins on normalised case, separators and unicode', (t) => {
  const { accented, a, resolver } = fixture(t)
  const decomposed = 'café/DÉJÀ VU.mp3'.normalize('NFD')
  assert.deepEqual(resolver.resolve({ id: 'c', path: decomposed }), { id: 'c', file: accented, by: RESOLVED_BY.relative })
  assert.equal(resolver.resolve({ id: 'a', path: 'ARTIST\\Album\\01 song.MP3' }).file, a)
  assert.equal(resolver.resolve({ id: 'a', path: 'Music/Artist/Album/01 Song.mp3' }).file, a)
})

test('a stale reported path falls back to the relative join', (t) => {
  const { root, a, resolver } = fixture(t)
  const result = resolver.resolve({ id: 'a', path: path.join(root, 'folder-0000000000000000', 'Artist', 'Album', '01 Song.mp3') })
  assert.deepEqual([result.file, result.by], [a, RESOLVED_BY.relative])
})

test('tag-derived paths that are not on disk and ambiguous names stay unresolved', (t) => {
  const { archive, music, resolver } = fixture(t)
  touch(path.join(music, 'Dup', 'Same.mp3'))
  touch(path.join(archive, 'Dup', 'Same.mp3'))
  assert.equal(resolver.resolve({ id: 'x', path: '[Unknown Artist]/[Unknown Album]/nope.mp3' }).by, RESOLVED_BY.unresolved)
  assert.equal(resolver.resolve({ id: 'x', path: 'Dup/Same.mp3' }).by, RESOLVED_BY.unresolved)
  assert.equal(resolver.resolve({ id: 'x' }).by, RESOLVED_BY.unresolved)
})

test('records made before the flag hold only a song ID and resolve through the API', async (t) => {
  const { root, a, resolver } = fixture(t)
  const name = linkName(root, path.dirname(path.dirname(path.dirname(a))))
  const server = new Map([['song-1', { id: 'song-1', path: path.join(root, name, 'Artist', 'Album', '01 Song.mp3') }]])
  const calls = []
  const getSong = async (id) => { calls.push(id); return server.get(id) }
  const result = await resolver.resolveId('song-1', getSong)
  assert.deepEqual([result.file, result.by, calls], [a, RESOLVED_BY.reported, ['song-1']])
  assert.equal((await resolver.resolveId('gone', getSong)).by, RESOLVED_BY.unresolved)
})

import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply, MARKER } from '../src/apply.ts'
import { categorize } from '../src/categories.ts'
import type { Enrichment } from '../src/enrich.ts'
import { inventory, type Inventory } from '../src/inventory.ts'
import { organize } from '../src/layout.ts'
import { propose } from '../src/proposal.ts'
import { readTags } from '../src/tags.ts'

const TONE = join(import.meta.dirname, '../fixtures/tone.mp3')
const LOOSE = 'Mixed/Six Rivers - Northern Light.mp3'

let dir = ''
let library = ''
let inv: Inventory
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tagsmith-apply-'))
  library = join(dir, 'library')
  await mkdir(join(library, 'Mixed'), { recursive: true })
  // two loose files, so the folder is not a one-off single
  await copyFile(TONE, join(library, LOOSE))
  await copyFile(TONE, join(library, 'Mixed/Other Band - Other Song.mp3'))
  inv = await inventory([library])
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const enrichment: Enrichment = {
  version: 1,
  albums: {},
  tracks: {
    [LOOSE]: {
      via: 'recording',
      recording: 'rec-1',
      title: 'Northern Light',
      artist: '6 Rivers',
      album: 'Long Way Home',
      albumartist: '6 Rivers',
      track: 6,
      disc: 1,
      year: 2000,
      release: 'rel-1',
      releaseGroup: 'rg-1',
      cover: 'https://example.org/front.jpg',
      loudness: { lufs: -9.1, peak: -0.2, gain: -8.9 },
    },
  },
}

async function run(to: string, layout: 'keep' | 'organize' = 'keep') {
  const c = categorize(inv, [], enrichment)
  const p = propose(inv, c, enrichment)
  const cover = async (release: string) => (release === 'rel-1' ? Buffer.from([0xff, 0xd8, 0xff, 0xd9]) : undefined)
  return { c, p, done: await apply(inv, c, p, { to, layout, cover, lyrics: async () => '[00:01.00]la' }) }
}

describe('apply', () => {
  it('tags a copy, reads back every field, keeps the audio and leaves the library as it was', async () => {
    const original = await readFile(join(library, LOOSE))
    const to = join(dir, 'copy')
    const { p, done } = await run(to)
    expect(done.summary).toMatchObject({ files: 2, mismatches: 0, errors: 0, audioChanged: 0, covers: 1, lyrics: 0 })
    const written = p.files.find((f) => f.path === LOOSE)
    // the junk album 'FREE MP3s' is cleared on the file MusicBrainz found no album for
    expect(p.files.find((f) => f.path !== LOOSE)?.changes).toContainEqual(expect.objectContaining({ field: 'album', from: 'FREE MP3s', to: '' }))
    expect(written?.changes).toContainEqual(expect.objectContaining({ field: 'album', to: 'Long Way Home', source: 'musicbrainz' }))
    expect((await readTags(join(to, LOOSE))).tags).toMatchObject({ title: 'Northern Light', album: 'Long Way Home', year: '2000', mb_albumid: 'rel-1' })
    expect(await readFile(join(library, LOOSE))).toEqual(original)
  })

  it('writes only outside the library, and over nothing it did not make', async () => {
    await expect(run(join(library, 'copy'))).rejects.toThrow(/outside the scanned library/)
    await expect(run(dir)).rejects.toThrow(/outside the scanned library/)
    await symlink(join(library, 'Mixed'), join(dir, 'link'))
    await expect(run(join(dir, 'link', 'copy'))).rejects.toThrow(/outside the scanned library/)
    const busy = join(dir, 'busy')
    await mkdir(busy)
    await writeFile(join(busy, 'notes.txt'), 'mine')
    await expect(run(busy)).rejects.toThrow(/not empty/)
    const to = join(dir, 'copy')
    await run(to)
    await writeFile(join(to, 'stale.txt'), '')
    await run(to)
    expect((await readdir(to)).sort()).toEqual([MARKER, 'Mixed', 'Playlists'])
  })

  it('organizes the copy by album artist, album and kind', async () => {
    const to = join(dir, 'organized')
    const { c, done } = await run(to, 'organize')
    expect(organize(c).get(LOOSE)).toBe('Singles/6 Rivers - Northern Light.mp3')
    expect(done.files.map((f) => f.to).sort()).toEqual(['Singles/6 Rivers - Northern Light.mp3', 'Singles/Six Rivers - Other Song.mp3'])
  })
})

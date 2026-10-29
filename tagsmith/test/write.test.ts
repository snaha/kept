import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { audioDigest } from '../src/audio-digest.ts'
import { onDisk, type Field } from '../src/proposal.ts'
import { readTags } from '../src/tags.ts'
import { writeTags } from '../src/write.ts'

// one second of a tone, tagged by ffmpeg as the test library's rips are: ID3v2.3 with a TYER year, plus ID3v1
const TONE = join(import.meta.dirname, '../fixtures/tone.mp3')

let dir = ''
let file = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tagsmith-write-'))
  file = join(dir, 'tone.mp3')
  await copyFile(TONE, file)
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('writeTags', () => {
  it('writes every proposal field so that it reads back as proposed', async () => {
    const set: Partial<Record<Field, string>> = {
      title: 'Northern Light',
      artist: '6 Rivers',
      album: 'Long Way Home',
      albumartist: '6 Rivers',
      track: '6',
      disc: '1',
      year: '2000',
      genre: 'Alternative Rock',
      compilation: '1',
      remixer: 'Harbour Jones; Lowlight',
      djmixer: 'DJ Nova',
      musicbrainz_trackid: '1a2b3c4d-0000-4000-8000-000000000001',
      musicbrainz_albumid: '1a2b3c4d-0000-4000-8000-000000000002',
      musicbrainz_releasegroupid: '1a2b3c4d-0000-4000-8000-000000000003',
      musicbrainz_artistid: '1a2b3c4d-0000-4000-8000-000000000004; 1a2b3c4d-0000-4000-8000-000000000005',
      replaygain_track_gain: '-5.60 dB',
      replaygain_track_peak: '0.966051',
      replaygain_album_gain: '-6.10 dB',
      replaygain_album_peak: '1.000000',
    }
    await writeTags(file, { set, cover: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]), lyrics: '[00:01.00]la la' })
    const back = await readTags(file)
    // 'Alternative Rock' as text: a numeric ID3v1 genre reads back as 'Alt. Rock' elsewhere
    for (const [field, want] of Object.entries(set) as [Field, string][]) expect([field, onDisk(back, field)]).toEqual([field, want])
    expect(back.pictures).toHaveLength(1)
    expect(back.extra.lyrics).toBeDefined()
    expect(Object.keys(back.raw)).toEqual(['ID3v2.4'])
  })

  it('keeps what only ID3v1 or an ID3v2.3 year held when other fields change, and never touches the audio', async () => {
    const before = await audioDigest(file)
    await writeTags(file, { set: { title: 'Northern Light' } })
    const back = await readTags(file)
    expect(back.tags).toMatchObject({ title: 'Northern Light', artist: 'Six Rivers', year: '2000', genre: 'Other' })
    expect(await audioDigest(file)).toBe(before)
  })

  it('clears a field set to empty', async () => {
    await writeTags(file, { set: { album: '', genre: '' } })
    expect((await readTags(file)).tags).toMatchObject({ album: '', genre: '' })
  })
})

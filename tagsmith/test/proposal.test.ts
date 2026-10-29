import { describe, expect, it } from 'vitest'
import { categorize } from '../src/categories.ts'
import type { Enrichment } from '../src/enrich.ts'
import { classify, type Folder, type Inventory } from '../src/inventory.ts'
import { propose } from '../src/proposal.ts'
import { emptyTags, type FileInfo, type Tags } from '../src/tags.ts'

const ROOT = '/m'
const dir = `${ROOT}/Mixed`

const file = (name: string, tags: Partial<Tags>, extra: Record<string, unknown> = {}): FileInfo => ({
  path: `${dir}/${name}`,
  tags: { ...emptyTags(), ...tags },
  extra,
  raw: { 'ID3v2.3': [] },
  duration: 232,
  pictures: [],
})

const folder = (files: FileInfo[]): Folder => {
  const { class: cls, stats } = classify(dir, files)
  return { dir, class: cls, files, images: [], stats, identified: false, findings: [] }
}

describe('propose', () => {
  it('lists each new value with its source, formats ReplayGain and never clears a tag', () => {
    const inv: Inventory = {
      roots: [ROOT],
      scanned: '',
      unreadable: [],
      folders: [
        folder([
          file('The Lanterns - Tides (Harbour Jones Remix).mp3', { artist: 'The Lanterns', title: 'Tides (Harbour Jones Remix)', genre: 'Rock', comment: '' } as Partial<Tags>),
          file('Lanters of Dusk - Slow Train.mp3', { artist: 'Lanters of Dusk', title: 'Slow Train', year: '1999' }),
          file('Glassworks - Paper Kite.mp3', { artist: 'Glassworks', title: 'Paper Kite' }, { replaygain_track_gain: { dB: -6.2, ratio: 0.24 } }),
        ]),
      ],
    }
    const e: Enrichment = {
      version: 1,
      albums: {},
      tracks: {
        'Mixed/The Lanterns - Tides (Harbour Jones Remix).mp3': { via: 'recording', recording: 'rec-1', title: 'Tides (Harbour Jones remix)', artist: 'The Lanterns', year: 1996, artists: ['art-1'], loudness: { lufs: -12.4, peak: -0.3, gain: -5.6 } },
        'Mixed/Lanters of Dusk - Slow Train.mp3': { via: 'recording', recording: 'rec-2', title: 'Slow Train', artist: 'Lanterns of Dusk', year: 1998 },
        'Mixed/Glassworks - Paper Kite.mp3': { loudness: { lufs: -11.8, peak: 0, gain: -6.2 } },
      },
    }
    const p = propose(inv, categorize(inv, [], e), e)
    const changes = (name: string) => Object.fromEntries((p.files.find((f) => f.path.endsWith(name))?.changes ?? []).map((c) => [c.field, [c.to, c.source]]))

    expect(changes('Tides (Harbour Jones Remix).mp3')).toMatchObject({
      year: ['1996', 'musicbrainz'],
      remixer: ['Harbour Jones', 'credits'],
      musicbrainz_trackid: ['rec-1', 'musicbrainz'],
      musicbrainz_artistid: ['art-1', 'musicbrainz'],
      replaygain_track_gain: ['-5.60 dB', 'loudness'],
      replaygain_track_peak: ['0.966051', 'loudness'],
    })
    // MusicBrainz's casing is proposed; the genre has no replacement, so it is left as tagged rather than cleared
    expect(changes('Tides (Harbour Jones Remix).mp3').title).toEqual(['Tides (Harbour Jones remix)', 'musicbrainz'])
    expect(changes('Tides (Harbour Jones Remix).mp3')).not.toHaveProperty('genre')
    expect(changes('Slow Train.mp3')).toMatchObject({ artist: ['Lanterns of Dusk', 'musicbrainz'], year: ['1998', 'musicbrainz'] })
    // a ReplayGain the file already carries is not written again
    expect(changes('Paper Kite.mp3')).not.toHaveProperty('replaygain_track_gain')
    expect(p.summary.bySource.loudness).toBe(3)
  })
})
